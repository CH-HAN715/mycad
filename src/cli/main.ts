#!/usr/bin/env node
/**
 * mycad CLI —— agent-first 入口。
 *
 * 契约：
 * - 正常输出到 stdout；加 --json 时一律输出单份 JSON（含错误），便于程序解析。
 * - 退出码：0 成功，1 校验不通过，2 输入/用法错误。
 * - 只暴露已经实现的能力（当前为 L2 截面特性），不预留空命令。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SectionProperties } from '../geom/inertia.ts';
import { SECTION_PROVENANCE, sectionProperties, sig } from '../geom/inertia.ts';
import { GeometryInputError, v2 } from '../geom/polygon.ts';
import type { Vec2 } from '../geom/polygon.ts';
import type { ProfileMeta, ProfileSpec } from '../geom/profile.ts';
import { PROFILE_PROVENANCE, buildProfile, parseProfileSpec } from '../geom/profile.ts';
import { TOL } from '../geom/tolerance.ts';
import { UNIT_SCHEMA } from '../geom/units.ts';
import { buildSectionReport, renderSectionReportMarkdown, serializeSectionValues } from '../report/sectionReport.ts';
import { DXF_PROVENANCE, sectionToDxf } from '../io/dxf.ts';
import type { FrameInput, FrameModel } from '../frame/model.ts';
import { FRAME_PROVENANCE, FrameInputError, buildFrame, parseFrameInput } from '../frame/model.ts';
import type { Bom } from '../production/bom.ts';
import { BOM_PROVENANCE, buildBom } from '../production/bom.ts';
import type { CutOptions, CutPieceInput, CutPlan } from '../production/cutPlan.ts';
import { CUT_PROVENANCE, CutInputError, planCuts } from '../production/cutPlan.ts';
import { VERIFY_CASES, compareToExpectation, symmetryProblems } from '../verify/fixtures.ts';

const EXIT = { ok: 0, verifyFailed: 1, badInput: 2 } as const;

class CliError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly exitCode: number;

  constructor(code: string, message: string, hint: string, exitCode: number = EXIT.badInput) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.hint = hint;
    this.exitCode = exitCode;
  }
}

function fail(code: string, message: string, hint: string, exitCode: number = EXIT.badInput): never {
  throw new CliError(code, message, hint, exitCode);
}

const USAGE = `mycad —— 铝型材框架设计引擎（当前实现：L1 截面 DSL、L2 截面特性、L4 框架、L5 BOM/下料）

用法：
  mycad section [--json] [--file <path> | --preset <id> | --profile <path|->]
      从 JSON 读取外轮廓与孔洞，计算面积、形心、Ix/Iy/Ixy、主轴、W。
      输入形如：{"outer": [[0,0],[40,0],[40,20],[0,20]], "holes": [[[...]]]}
      不给 --file 时从 stdin 读取。

      --profile 读取参数化型材规格，生成截面后再计算，例如：
      {"width":20,"height":20,
       "slot":{"opening":6,"depth":5.5,"headWidth":8,"headStart":2},
       "bore":{"radius":2.25,"sagitta":0.01}}

  mycad bench [--json]
      跑手算对照算例库，逐项比较并给出最大相对误差。

  mycad report [--json] [--out <path.md>] [--file <path> | --preset <id> | --profile <path|->]
      生成可复核的 Markdown 报告：结果 + 公式 + 单位 + 假设 + 局限 + 免责。
      --out 写入文件（自动创建父目录）；不给则打印到 stdout。
      --json 输出机器可读报告对象，可与其他选项组合。

  mycad frame [--json] [--file <path|->]
      求解轴对齐框架：杆件长度、下料长度、关节聚类与共线干涉检查。

  mycad bom [--json] [--file <path|->] [--stock <mm> --kerf <mm>]
      输出型材与下料清单；给出棒料与锯缝时附带一维下料方案。

  mycad cut [--json] [--file <path|->] --stock <mm> --kerf <mm>
      一维定尺下料。输入形如 [{"id":"a","lengthMm":600,"quantity":2}]。

  mycad dxf [--json] [--out <path.dxf>] [--file <path> | --preset <id> | --profile <path|->]
      输出截面轮廓 DXF（AC1009，LINE 实体，单位 mm）。不给 --out 则打印到 stdout。

  mycad help | version
      --help / -h       显示本帮助
      --version / -v    显示版本

退出码：0 成功，1 校验不通过，2 输入或用法错误。
`;

const readVersion = (): string => {
  const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  if (isRecord(pkg) && typeof pkg['version'] === 'string') return pkg['version'];
  return '0.0.0';
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface Flags {
  readonly json: boolean;
  readonly file: string | null;
  readonly preset: string | null;
  readonly profile: string | null;
  readonly out: string | null;
  readonly stock: number | null;
  readonly kerf: number | null;
}

interface FlagOptions {
  /** 只有 report 接受 --out；其他命令传 true 会在解析阶段直接报错。 */
  readonly allowOut?: boolean;
  /** 只有 bom/cut 接受 --stock/--kerf。 */
  readonly allowStockKerf?: boolean;
}

function readNumericFlag(args: readonly string[], index: number, name: string): { value: number; next: number } {
  const raw = args[index + 1];
  if (raw === undefined) fail('E_USAGE', `${name} 缺少数值`, `用法：${name} <mm>`);
  const value = Number(raw);
  if (!Number.isFinite(value)) fail('E_USAGE', `${name} 不是有限数：${raw}`, '长度单位为 mm');
  return { value, next: index + 1 };
}

function parseFlags(args: readonly string[], options: FlagOptions = {}): Flags {
  let json = false;
  let file: string | null = null;
  let preset: string | null = null;
  let profile: string | null = null;
  let out: string | null = null;
  let stock: number | null = null;
  let kerf: number | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--file' || arg === '-f') {
      const value = args[++i];
      if (value === undefined) fail('E_USAGE', `${arg} 缺少路径`, '用法：mycad section --file <path>');
      file = value;
      continue;
    }
    if (arg === '--preset') {
      const value = args[++i];
      if (value === undefined) fail('E_USAGE', '--preset 缺少算例 id', `可用：${VERIFY_CASES.map((c) => c.id).join('、')}`);
      preset = value;
      continue;
    }
    if (arg === '--profile') {
      const value = args[++i];
      if (value === undefined) fail('E_USAGE', '--profile 缺少路径', '用法：mycad section --profile <path|->，- 表示 stdin');
      profile = value;
      continue;
    }
    if (arg === '--out' || arg === '-o') {
      if (options.allowOut !== true) {
        fail('E_USAGE', `${arg} 仅适用于 report 命令`, '用法：mycad report --preset <id> --out <path.md>');
      }
      const value = args[++i];
      if (value === undefined) fail('E_USAGE', `${arg} 缺少路径`, '用法：mycad report --preset <id> --out <path.md>');
      out = value;
      continue;
    }
    if (arg === '--stock') {
      if (options.allowStockKerf !== true) {
        fail('E_USAGE', '--stock 仅适用于 bom/cut 命令', '用法：mycad cut --file <path> --stock 6000 --kerf 3');
      }
      const { value, next } = readNumericFlag(args, i, '--stock');
      stock = value;
      i = next;
      continue;
    }
    if (arg === '--kerf') {
      if (options.allowStockKerf !== true) {
        fail('E_USAGE', '--kerf 仅适用于 bom/cut 命令', '用法：mycad cut --file <path> --stock 6000 --kerf 3');
      }
      const { value, next } = readNumericFlag(args, i, '--kerf');
      kerf = value;
      i = next;
      continue;
    }
    fail('E_USAGE', `未知参数：${arg}`, '运行 mycad help 查看用法');
  }

  const sources = [file, preset, profile].filter((v) => v !== null);
  if (sources.length > 1) {
    fail('E_USAGE', '--file、--preset、--profile 只能选一个', '二选一：读几何 JSON、跑内置算例、或读型材规格');
  }
  return { json, file, preset, profile, out, stock, kerf };
}

function readInput(file: string | null): string {
  if (file !== null) {
    try {
      return readFileSync(file, 'utf8');
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      fail('E_INPUT_FILE', `无法读取文件：${file}`, reason);
    }
  }
  if (process.stdin.isTTY) {
    fail(
      'E_INPUT_MISSING',
      '没有输入',
      '用 --file <path> 指定 JSON 文件，或通过管道传入：cat section.json | mycad section --json',
    );
  }
  return readFileSync(0, 'utf8');
}

function parsePoint(raw: unknown, where: string): Vec2 {
  if (Array.isArray(raw)) {
    const x = raw[0];
    const y = raw[1];
    if (raw.length !== 2 || typeof x !== 'number' || typeof y !== 'number') {
      fail('E_INPUT_POINT', `${where} 的点格式错误`, '点必须是 [x, y] 两个数，或 {"x": 数值, "y": 数值}');
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      fail('E_INPUT_POINT', `${where} 的点含非有限数值：[${x}, ${y}]`, '坐标必须是有限数，单位为 mm');
    }
    return v2(x, y);
  }
  if (isRecord(raw)) {
    const x = raw['x'];
    const y = raw['y'];
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      fail('E_INPUT_POINT', `${where} 的点格式错误`, '对象点必须形如 {"x": 数值, "y": 数值}，单位为 mm');
    }
    return v2(x, y);
  }
  fail('E_INPUT_POINT', `${where} 含非法点：${JSON.stringify(raw)}`, '点必须是 [x, y] 或 {"x": .., "y": ..}');
}

function parsePoints(raw: readonly unknown[], where: string): Vec2[] {
  return raw.map((point, i) => parsePoint(point, `${where}[${i}]`));
}

function parseJsonText(text: string, hint: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail('E_INPUT_JSON', 'JSON 解析失败', `${reason}；${hint}`);
  }
}

function parseInput(text: string): { outer: Vec2[]; holes: Vec2[][] } {
  const data = parseJsonText(text, '输入形如 {"outer": [[0,0],[40,0],[40,20],[0,20]], "holes": []}');

  if (!isRecord(data)) {
    fail('E_INPUT_SHAPE', '输入必须是 JSON 对象', '形如 {"outer": [[0,0],[40,0],[40,20],[0,20]], "holes": []}');
  }
  const outerRaw = data['outer'];
  if (!Array.isArray(outerRaw)) {
    fail('E_INPUT_SHAPE', '缺少 outer 点数组', 'outer 为外轮廓闭合点列，例：[[0,0],[40,0],[40,20],[0,20]]');
  }
  const outer = parsePoints(outerRaw, 'outer');

  const holesRaw = data['holes'] ?? [];
  if (!Array.isArray(holesRaw)) {
    fail('E_INPUT_SHAPE', 'holes 必须是数组', 'holes 为孔洞点列的数组，无孔时写 [] 或省略');
  }
  const holes = holesRaw.map((hole, i) => {
    if (!Array.isArray(hole)) {
      fail('E_INPUT_SHAPE', `holes[${i}] 不是点数组`, '每个孔是一条闭合点列，例：[[3,3],[37,3],[37,17],[3,17]]');
    }
    return parsePoints(hole, `holes[${i}]`);
  });

  return { outer, holes };
}

/** 显示层噪声清理：小于重合容差的量按 0 输出，避免形心出现 -6.6e-19 这类伪精度。 */
const denoise = (v: number): number => (Math.abs(v) < TOL.coincide ? 0 : v);

const human = (v: number): string => String(sig(denoise(v), 6));

/** 中文按 2 列宽计算，保证表格在终端里对齐。 */
function padLabel(label: string, width: number): string {
  let used = 0;
  for (const ch of label) used += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return label + ' '.repeat(Math.max(1, width - used));
}

/** 主轴角归一到 (-90°, 90°]，并把正交方向（θ+90）也归一，避免输出 180°。 */
function orthogonalDeg(deg: number): number {
  let d = deg + 90;
  while (d > 90) d -= 180;
  while (d <= -90) d += 180;
  return d;
}

function printSection(s: SectionProperties, profile: ProfileMeta | null = null): void {
  // 主轴角在各向同性截面上没有意义，不能编一个 -45° 出来。
  const isotropic = Math.abs(s.principal.imax - s.principal.imin) <= TOL.relVerify * Math.max(s.principal.imax, 1);
  const theta = isotropic ? '任意（imax ≈ imin）' : `${human(s.principal.thetaDeg)}°`;
  const thetaOrtho = isotropic ? '任意（imax ≈ imin）' : `${human(orthogonalDeg(s.principal.thetaDeg))}°`;

  const rows: readonly (readonly [string, string])[] = [
    ['面积 A', `${human(s.area)} mm^2`],
    ['形心 (x, y)', `${human(s.centroid.x)}, ${human(s.centroid.y)} mm`],
    ['Ix', `${human(s.ix)} mm^4`],
    ['Iy', `${human(s.iy)} mm^4`],
    ['Ixy', `${human(s.ixy)} mm^4`],
    ['主轴 imax', `${human(s.principal.imax)} mm^4 @ ${theta}`],
    ['主轴 imin', `${human(s.principal.imin)} mm^4 @ ${thetaOrtho}`],
    ['回转半径 imax / imin', `${human(s.principal.radiusMax)} / ${human(s.principal.radiusMin)} mm`],
    ['Wx 上 / 下', `${human(s.modulus.wxTop)} / ${human(s.modulus.wxBottom)} mm^3`],
    ['Wy 左 / 右', `${human(s.modulus.wyLeft)} / ${human(s.modulus.wyRight)} mm^3`],
    ['包围盒 x', `[${human(s.bbox.xMin)}, ${human(s.bbox.xMax)}] mm`],
    ['包围盒 y', `[${human(s.bbox.yMin)}, ${human(s.bbox.yMax)}] mm`],
  ];

  for (const [label, value] of rows) console.log(`${padLabel(label, 26)}${value}`);
  console.log('');
  if (profile !== null) {
    const faces = profile.slotFaces.length > 0 ? profile.slotFaces.join('、') : '无';
    console.log(`型材模型：${profile.slotCount} 槽（${faces}），中心孔 ${profile.boreSegments} 边形 r=${profile.boreRadius} mm`);
    console.log(`未建模：${PROFILE_PROVENANCE.notModeled.join('、')}`);
    console.log(`边界：${PROFILE_PROVENANCE.disclaimer}`);
  }
  console.log(`方法：${SECTION_PROVENANCE.method}（对多边形为精确解，非拟合）`);
  console.log('公式：加 --json 可获取完整公式与适用范围清单');
  console.log(`免责：${SECTION_PROVENANCE.disclaimer}`);
}

interface SectionInput {
  readonly source: string;
  readonly outer: Vec2[];
  readonly holes: Vec2[][];
  readonly profileSpec: ProfileSpec | null;
  readonly profileMeta: ProfileMeta | null;
}

/** section 与 report 共用的输入解析：几何 JSON、内置算例、参数化型材规格。 */
function resolveSectionInput(flags: Flags): SectionInput {
  let title = 'stdin';
  let outer: Vec2[];
  let holes: Vec2[][];
  let profileSpec: ProfileSpec | null = null;
  let profileMeta: ProfileMeta | null = null;

  if (flags.preset !== null) {
    const found = VERIFY_CASES.find((c) => c.id === flags.preset);
    if (found === undefined) {
      fail('E_USAGE', `未知算例：${flags.preset}`, `可用：${VERIFY_CASES.map((c) => c.id).join('、')}`);
    }
    title = `preset:${found.id}`;
    outer = [...found.outer];
    holes = found.holes.map((h) => [...h]);
  } else if (flags.profile !== null) {
    const text = readInput(flags.profile === '-' ? null : flags.profile);
    const raw = parseJsonText(text, '型材规格形如 {"width":20,"height":20,"slot":{...},"bore":{...}}');
    profileSpec = parseProfileSpec(raw);
    const geometry = buildProfile(profileSpec);
    outer = [...geometry.outer];
    holes = geometry.holes.map((hole) => [...hole]);
    profileMeta = geometry.meta;
    title = `profile:${flags.profile}`;
  } else {
    const parsed = parseInput(readInput(flags.file));
    if (flags.file !== null) title = flags.file;
    outer = parsed.outer;
    holes = parsed.holes;
  }

  return { source: title, outer, holes, profileSpec, profileMeta };
}

function cmdSection(args: readonly string[]): number {
  const flags = parseFlags(args);
  const input = resolveSectionInput(flags);
  const { outer, holes } = input;
  const props = sectionProperties(outer, holes);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'section',
          version: readVersion(),
          input: {
            source: input.source,
            outer: outer.map((p) => [p.x, p.y]),
            holes: holes.map((hole) => hole.map((p) => [p.x, p.y])),
          },
          units: UNIT_SCHEMA,
          result: serializeSectionValues(props),
          ...(input.profileMeta !== null && input.profileSpec !== null
            ? { profile: { spec: input.profileSpec, meta: input.profileMeta, provenance: PROFILE_PROVENANCE } }
            : {}),
          provenance: SECTION_PROVENANCE,
        },
        null,
        2,
      ),
    );
  } else {
    printSection(props, input.profileMeta);
  }
  return EXIT.ok;
}

function writeTextFile(path: string, text: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    fail('E_OUTPUT', `无法写入文件：${path}`, reason);
  }
}

function cmdReport(args: readonly string[]): number {
  const flags = parseFlags(args, { allowOut: true });
  const input = resolveSectionInput(flags);
  const props = sectionProperties(input.outer, input.holes);
  const report = buildSectionReport({
    source: input.source,
    version: readVersion(),
    properties: props,
    ...(input.profileSpec !== null && input.profileMeta !== null
      ? { profile: { spec: input.profileSpec, meta: input.profileMeta } }
      : {}),
  });
  const markdown = renderSectionReportMarkdown(report);

  if (flags.out !== null) writeTextFile(flags.out, markdown);
  if (flags.json) {
    console.log(JSON.stringify({ ok: true, command: 'report', version: readVersion(), report }, null, 2));
  } else if (flags.out === null) {
    console.log(markdown);
  } else {
    console.log(`已写入报告：${flags.out}`);
  }
  return EXIT.ok;
}

function assertNoPresetOrProfile(flags: Flags, command: string): void {
  if (flags.preset !== null || flags.profile !== null) {
    fail('E_USAGE', `${command} 只接受 --file 或 stdin 的 JSON`, '--preset/--profile 仅用于 section/report');
  }
}

function frameInputFromFlags(flags: Flags): FrameInput {
  assertNoPresetOrProfile(flags, 'frame/bom');
  const text = readInput(flags.file);
  const raw = parseJsonText(
    text,
    '框架输入形如 {"profiles":[{"id":"p","spec":{"width":20,"height":20}}],"members":[{"id":"m","profileId":"p","start":[0,0,0],"end":[600,0,0]}]}',
  );
  return parseFrameInput(raw);
}

function pointJson(point: { x: number; y: number; z: number }): readonly [number, number, number] {
  return [point.x, point.y, point.z];
}

function serializeFrame(model: FrameModel): Record<string, unknown> {
  return {
    profiles: model.profiles.map((profile) => ({
      id: profile.id,
      spec: profile.spec,
      meta: profile.meta,
      areaMm2: profile.area,
      material: profile.material,
    })),
    members: model.members.map((member) => ({
      id: member.id,
      profileId: member.profileId,
      axis: member.axis,
      start: pointJson(member.start),
      end: pointJson(member.end),
      centerlineLengthMm: member.centerlineLength,
      trimStartMm: member.trimStart,
      trimEndMm: member.trimEnd,
      cutLengthMm: member.cutLength,
      areaMm2: member.area,
      volumeMm3: member.volume,
      massKg: member.mass,
    })),
    joints: model.joints.map((joint) => ({
      point: pointJson(joint.point),
      memberCount: joint.memberCount,
      ends: joint.ends,
    })),
  };
}

function printFrame(model: FrameModel): void {
  console.log('杆件：');
  console.log('id                  型材       轴   中心线      让量起/止      下料        体积          质量');
  for (const member of model.members) {
    const mass = member.mass === null ? '—' : `${human(member.mass)} kg`;
    console.log(
      `${member.id.padEnd(20)}${member.profileId.padEnd(10)}${member.axis}   ` +
        `${human(member.centerlineLength).padStart(9)}  ${human(member.trimStart)}/${human(member.trimEnd)}  ` +
        `${human(member.cutLength).padStart(9)}  ${human(member.volume).padStart(12)}  ${mass}`,
    );
  }
  console.log('');
  console.log(`关节：${model.joints.length} 个`);
  for (const joint of model.joints) {
    const [x, y, z] = pointJson(joint.point);
    const ends = joint.ends.map((end) => `${end.memberId}.${end.end}`).join('、');
    console.log(`  (${x}, ${y}, ${z}) ${joint.memberCount} 端：${ends}`);
  }
  console.log('');
  console.log(`方法：${FRAME_PROVENANCE.method}`);
  console.log(`假设：${FRAME_PROVENANCE.assumptions.join('；')}`);
  console.log(`局限：${FRAME_PROVENANCE.limitations.join('；')}`);
  console.log(`免责：${FRAME_PROVENANCE.disclaimer}`);
}

function cmdFrame(args: readonly string[]): number {
  const flags = parseFlags(args);
  const model = buildFrame(frameInputFromFlags(flags));

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'frame',
          version: readVersion(),
          units: UNIT_SCHEMA,
          model: serializeFrame(model),
          provenance: FRAME_PROVENANCE,
        },
        null,
        2,
      ),
    );
  } else {
    printFrame(model);
  }
  return EXIT.ok;
}

function cutOptionsFromFlags(flags: Flags, required: boolean): CutOptions | undefined {
  if (flags.stock === null) {
    if (flags.kerf !== null) {
      fail('E_USAGE', '--kerf 需要配合 --stock', '先给出棒料长度，再给出锯缝宽度');
    }
    if (required) {
      fail('E_USAGE', '缺少 --stock', '用法：mycad cut --file <path> --stock 6000 --kerf 3');
    }
    return undefined;
  }
  if (flags.kerf === null) {
    fail('E_USAGE', '--stock 必须同时显式给出 --kerf', '锯缝不会静默按 0 处理；没有锯缝请写 --kerf 0');
  }
  return { stockLengthMm: flags.stock, kerfMm: flags.kerf };
}

function printBom(bom: Bom): void {
  console.log('型材清单：');
  console.log('id                  杆件数  面积        总下料长度    体积          质量');
  for (const profile of bom.profiles) {
    const mass = profile.totalMassKg === null ? '—' : `${human(profile.totalMassKg)} kg`;
    console.log(
      `${profile.profileId.padEnd(20)}${String(profile.memberCount).padStart(6)}  ` +
        `${human(profile.areaMm2).padStart(9)}  ${human(profile.totalCutLengthMm).padStart(12)}  ` +
        `${human(profile.totalVolumeMm3).padStart(12)}  ${mass}`,
    );
  }
  console.log('');
  console.log('下料清单：');
  for (const item of bom.cutList) {
    console.log(`  ${item.profileId}  ${human(item.lengthMm)} mm × ${item.quantity}`);
  }
  console.log('');
  console.log(`合计：${bom.totalMembers} 根，下料总长 ${human(bom.totalCutLengthMm)} mm，体积 ${human(bom.totalVolumeMm3)} mm^3`);
  if (bom.totalMassKg !== null) {
    console.log(`质量：${human(bom.totalMassKg)} kg（由截面面积 × 长度 × 密度得出）`);
  } else {
    console.log(`质量：未知（缺少材料密度：${bom.missingMaterialFor.join('、') || '未提供材料'}）`);
  }
  if (bom.stockPlan !== null) {
    console.log('');
    printCutPlan(bom.stockPlan);
  }
  console.log('');
  console.log(`分组精度：${BOM_PROVENANCE.groupingToleranceMm} mm`);
  console.log(`免责：${BOM_PROVENANCE.disclaimer}`);
}

function cmdBom(args: readonly string[]): number {
  const flags = parseFlags(args, { allowStockKerf: true });
  const options = cutOptionsFromFlags(flags, false);
  const model = buildFrame(frameInputFromFlags(flags));
  const bom = buildBom(model, options);

  if (flags.json) {
    console.log(JSON.stringify({ ok: true, command: 'bom', version: readVersion(), bom }, null, 2));
  } else {
    printBom(bom);
  }
  return EXIT.ok;
}

function parsePiecesInput(text: string): CutPieceInput[] {
  const data = parseJsonText(text, 'pieces 形如 [{"id":"a","lengthMm":600,"quantity":2}]');
  const raw = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data['pieces'])
      ? data['pieces']
      : fail('E_INPUT_SHAPE', '缺少 pieces 数组', 'pieces 形如 [{"id":"a","lengthMm":600,"quantity":2}]');

  return raw.map((item, i): CutPieceInput => {
    const where = `pieces[${i}]`;
    if (!isRecord(item)) fail('E_INPUT_SHAPE', `${where} 必须是对象`, '需包含 id、lengthMm、quantity');
    for (const key of Object.keys(item)) {
      if (!['id', 'lengthMm', 'quantity'].includes(key)) {
        fail('E_INPUT_SHAPE', `${where} 含未知字段：${key}`, '允许的字段：id、lengthMm、quantity');
      }
    }
    const id = item['id'];
    const lengthMm = item['lengthMm'];
    const quantity = item['quantity'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      fail('E_INPUT_SHAPE', `${where}.id 必须是非空字符串`, 'id 用于在方案中定位每一段');
    }
    if (typeof lengthMm !== 'number' || !Number.isFinite(lengthMm)) {
      fail('E_INPUT_SHAPE', `${where}.lengthMm 必须是有限数`, '长度单位为 mm');
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity)) {
      fail('E_INPUT_SHAPE', `${where}.quantity 必须是整数`, '数量用整数表示');
    }
    return { id, lengthMm, quantity };
  });
}

function printCutPlan(plan: CutPlan): void {
  console.log(`下料方案：棒料 ${human(plan.stockLengthMm)} mm，锯缝 ${human(plan.kerfMm)} mm（每段计一次，保守）`);
  for (const bar of plan.bars) {
    const pieces = bar.pieces.map((piece) => `${human(piece.lengthMm)}`).join(' + ');
    console.log(
      `  棒 #${String(bar.index).padStart(2)}：${pieces}  → 占用 ${human(bar.usedMm)}，` +
        `余料 ${human(bar.leftoverMm)}，损耗 ${human(bar.wasteMm)} mm`,
    );
  }
  console.log('');
  console.log(
    `合计：${plan.totalPieces} 段，棒料 ${plan.bars.length} 根，利用率 ${(plan.utilization * 100).toFixed(2)}%，` +
      `总损耗 ${human(plan.totalWasteMm)} mm`,
  );
  console.log(
    `下界：${plan.lowerBoundBars} 根，差距 ${plan.gapBars} 根` +
      `${plan.matchesLowerBound ? '（达到下界，但不等于已证明最优）' : '（启发式未达到下界）'}`,
  );
  console.log(`免责：${plan.disclaimer}`);
}

function cmdCut(args: readonly string[]): number {
  const flags = parseFlags(args, { allowStockKerf: true });
  assertNoPresetOrProfile(flags, 'cut');
  const options = cutOptionsFromFlags(flags, true)!;
  const pieces = parsePiecesInput(readInput(flags.file));
  const plan = planCuts(pieces, options);

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'cut',
          version: readVersion(),
          units: UNIT_SCHEMA,
          plan,
          provenance: CUT_PROVENANCE,
        },
        null,
        2,
      ),
    );
  } else {
    printCutPlan(plan);
  }
  return EXIT.ok;
}

function cmdDxf(args: readonly string[]): number {
  const flags = parseFlags(args, { allowOut: true });
  const input = resolveSectionInput(flags);
  const dxf = sectionToDxf(input.outer, input.holes);
  const lineCount = dxf.split('\n').filter((line, i, all) => line === 'LINE' && all[i - 1] === '0').length;

  if (flags.out !== null) writeTextFile(flags.out, dxf);
  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          command: 'dxf',
          version: readVersion(),
          input: { source: input.source },
          format: DXF_PROVENANCE.format,
          units: 'mm',
          lineCount,
          content: dxf,
          provenance: DXF_PROVENANCE,
        },
        null,
        2,
      ),
    );
  } else if (flags.out === null) {
    process.stdout.write(dxf);
  } else {
    console.log(`已写入 DXF：${flags.out}（${lineCount} 条 LINE）`);
    console.log(`边界：${DXF_PROVENANCE.disclaimer}`);
  }
  return EXIT.ok;
}

function cmdBench(args: readonly string[]): number {
  const flags = parseFlags(args);

  const rows = VERIFY_CASES.map((testCase) => {
    const actual = sectionProperties(testCase.outer, testCase.holes);
    const comparison = compareToExpectation(actual, testCase.expect);
    const symmetry =
      testCase.symmetry === 'none' ? [] : symmetryProblems(actual.modulus, testCase.symmetry);
    return { testCase, actual, comparison, symmetry, ok: comparison.ok && symmetry.length === 0 };
  });
  const failed = rows.filter((r) => !r.ok).length;

  if (flags.json) {
    console.log(
      JSON.stringify(
        {
          ok: failed === 0,
          command: 'bench',
          version: readVersion(),
          tolerance: { relVerify: TOL.relVerify },
          summary: { total: rows.length, passed: rows.length - failed, failed },
          cases: rows.map((r) => ({
            id: r.testCase.id,
            title: r.testCase.title,
            ok: r.ok,
            maxRelError: r.comparison.maxRelError,
            deviations: r.comparison.deviations,
            symmetryProblems: r.symmetry,
            derivation: r.testCase.derivation,
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log('算例                结果  最大相对误差');
    for (const r of rows) {
      const status = r.ok ? 'OK  ' : 'FAIL';
      console.log(`${r.testCase.id.padEnd(20)}${status}  ${r.comparison.maxRelError.toExponential(2)}`);
      for (const deviation of r.comparison.deviations) {
        console.log(
          `  - ${deviation.field}: 期望 ${deviation.expected}，实测 ${deviation.actual}（相对误差 ${deviation.relError.toExponential(2)}）`,
        );
      }
      for (const problem of r.symmetry) console.log(`  - ${problem}`);
    }
    console.log('');
    console.log(`共 ${rows.length} 例，通过 ${rows.length - failed}，失败 ${failed}；容差 ${TOL.relVerify}（相对误差）`);
  }

  return failed === 0 ? EXIT.ok : EXIT.verifyFailed;
}

function run(argv: readonly string[]): number {
  if (argv.length === 0) {
    console.log(USAGE);
    return EXIT.ok;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return EXIT.ok;
  }

  const command = argv[0]!;
  const rest = argv.slice(1);
  switch (command) {
    case 'section':
      return cmdSection(rest);
    case 'bench':
      return cmdBench(rest);
    case 'report':
      return cmdReport(rest);
    case 'frame':
      return cmdFrame(rest);
    case 'bom':
      return cmdBom(rest);
    case 'cut':
      return cmdCut(rest);
    case 'dxf':
      return cmdDxf(rest);
    case 'help':
      console.log(USAGE);
      return EXIT.ok;
    case 'version':
    case '--version':
    case '-v':
      console.log(`mycad ${readVersion()}`);
      return EXIT.ok;
    default:
      fail('E_USAGE', `未知命令：${command}`, '可用命令：section、report、frame、bom、cut、dxf、bench、help、version');
  }
}

interface ErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly hint: string;
  readonly exitCode: number;
  readonly reason?: string;
}

function describeError(error: unknown): ErrorInfo {
  if (error instanceof CliError) {
    return { code: error.code, message: error.message, hint: error.hint, exitCode: error.exitCode };
  }
  if (error instanceof GeometryInputError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      exitCode: EXIT.badInput,
      reason: error.reason,
    };
  }
  if (error instanceof FrameInputError || error instanceof CutInputError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      exitCode: EXIT.badInput,
      reason: error.reason,
    };
  }
  if (error instanceof RangeError) {
    return {
      code: 'E_INPUT_GEOMETRY',
      message: error.message,
      hint: '检查轮廓是否自交、孔洞是否大于外轮廓、绕向是否可归一',
      exitCode: EXIT.badInput,
    };
  }
  return {
    code: 'E_INTERNAL',
    message: error instanceof Error ? error.message : String(error),
    hint: '未预期的内部错误，请附完整输入与调用方式反馈',
    exitCode: EXIT.verifyFailed,
  };
}

process.exitCode = ((): number => {
  const argv = process.argv.slice(2);
  try {
    return run(argv);
  } catch (error) {
    const info = describeError(error);
    if (argv.includes('--json')) {
      const payload: Record<string, unknown> = { code: info.code, message: info.message, hint: info.hint };
      if (info.reason !== undefined) payload['reason'] = info.reason;
      console.log(JSON.stringify({ ok: false, error: payload }, null, 2));
    } else {
      console.error(`错误[${info.code}${info.reason !== undefined ? `/${info.reason}` : ''}]：${info.message}`);
      console.error(`提示：${info.hint}`);
    }
    return info.exitCode;
  }
})();
