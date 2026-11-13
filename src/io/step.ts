import type { Axis, FrameModel } from '../frame/model.ts';
import { buildProfile } from '../geom/profile.ts';
import type { ProfileSpec } from '../geom/profile.ts';
import type { Vec2 } from '../geom/polygon.ts';
import type { ConnectPlan, MiterCut } from '../connect/plan.ts';

/**
 * L7 输出层：框架 STEP（ISO 10303-21）导出。
 *
 * 几何口径：每根杆件按参数化截面的外轮廓与中心孔拉伸成棱柱；
 * 45° 斜切端按剪切平面建模，钻孔、端盖与倒角不在本版实体里。
 * 只用 PLANE + POLY_LOOP 的平面 B-rep，不依赖任何 CAD 内核。
 */

export const STEP_PROVENANCE = {
  format: 'ISO 10303-21 (STEP), AP214 AUTOMOTIVE_DESIGN, FACETED_BREP',
  units: 'mm（SI_UNIT(.MILLI.,.METRE.)）',
  geometry:
    '每根杆件按型材参数化截面的外轮廓与中心孔（正多边形）拉伸成棱柱；斜切端由平面剪切形成；实心体沿杆件轴线放置，起点取扣除 trimStart 后的物理端面',
  sectionFrame:
    '截面局部 u/v 映射与连接层一致：x 轴杆件 u=y,v=z；y 轴杆件 u=x,v=z；z 轴杆件 u=x,v=y；局部原点在截面形心',
  assumptions: [
    '长度取 cutLength（中心线口径）；斜切端在长点侧额外伸出半宽，整体下料长等于 cutLength 加斜切余量',
    '45° 斜切按剪切平面建模，长点固定在 −u/−v 侧（与二维图一致）；装配方向相反时须镜像确认',
    '端盖与倒角不在实体里',
    '钻孔不从实体中扣除；孔位与孔径见 drawing 输出',
    '中心孔按参数化正多边形拉伸，圆弧以折线近似（弦高由 profile 的 sagitta 控制）',
    '杆件几何在关节处按中心线首尾相接，不扣除连接件让量',
  ],
  limitations: [
    '不是可直接下料的实体验证模型：没有钻孔、端盖与连接件',
    '斜切只支持连接引擎给出的 45° 等截面平面剪切；非 45° 或变截面斜切不建模',
    '外轮廓不建模圆角、倒角与非对称槽位（与 PROFILE_PROVENANCE 同源）',
    '文件未用第三方 CAD 内核回读验证；结构自检见 tests/step.test.ts',
    '非 ASCII 杆件名不写入 STEP，实体名统一用 M1..Mn，原名见返回 legend',
  ],
  disclaimer:
    '本文件用于三维布局与干涉参考，不是可签收的制造模型；投产前须补钻孔与其余工艺特征，并由工程师确认。',
} as const;

type P3 = readonly [number, number, number];

export interface StepEntityRow {
  readonly label: string;
  readonly memberId: string;
  readonly profileId: string;
  readonly cutLengthMm: number;
}

export interface StepExportOptions {
  /** HEADER 中的文件名；默认 mycad-frame.step。 */
  readonly fileName?: string;
  /** 产品名（ASCII）；默认 Mycad Frame。 */
  readonly title?: string;
  /** 时间戳日期 YYYY-MM-DD；默认当天。 */
  readonly date?: string;
  /** 连接方案：提供时按其中的 45° 斜切修改端面；不给则全部按方切端。 */
  readonly plan?: ConnectPlan;
}

export interface StepExportResult {
  readonly text: string;
  readonly fileName: string;
  readonly solids: number;
  readonly miteredMembers: number;
  readonly faces: number;
  readonly points: number;
  readonly legend: readonly StepEntityRow[];
  readonly warnings: readonly string[];
}

const SECTION_AXES: Record<Axis, { readonly u: Axis; readonly v: Axis }> = {
  x: { u: 'y', v: 'z' },
  y: { u: 'x', v: 'z' },
  z: { u: 'x', v: 'y' },
} as const;

const UNIT: Record<Axis, P3> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const;

const vscale = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Newell 法向量：对平面多边形可靠，且不需要三点共线假设。 */
function newell(loop: readonly P3[]): P3 {
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** STEP 实数：至少带小数点，去掉无意义的尾零。 */
function fmt(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`STEP 导出遇到非有限数：${value}`);
  if (Math.abs(value) < 5e-5) return '0.';
  return value.toFixed(4).replace(/0+$/, '');
}

function stepString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function asciiTitle(value: string): string {
  const cleaned = value.replace(/[^\x20-\x7E]/g, '').trim();
  return cleaned.length > 0 ? cleaned : 'Mycad Frame';
}

class StepWriter {
  private readonly entities: string[] = [];
  private readonly pointCache = new Map<string, string>();
  private pointCountTotal = 0;
  private nextId = 0;

  add(body: string): string {
    this.nextId += 1;
    const id = `#${this.nextId}`;
    this.entities.push(`${id}=${body};`);
    return id;
  }

  point(p: P3): string {
    const key = `${fmt(p[0])}|${fmt(p[1])}|${fmt(p[2])}`;
    const cached = this.pointCache.get(key);
    if (cached !== undefined) return cached;
    const id = this.add(`CARTESIAN_POINT('',(${fmt(p[0])},${fmt(p[1])},${fmt(p[2])}))`);
    this.pointCache.set(key, id);
    return id;
  }

  text(): string {
    return this.entities.join('\n');
  }

  get entityCount(): number {
    return this.nextId;
  }

  get pointCount(): number {
    return this.pointCountTotal;
  }

  /** 每个实体独立的点缓存：不同杆件坐标重合时不能被合并成一个拓扑点。 */
  resetPoints(): void {
    this.pointCountTotal += this.pointCache.size;
    this.pointCache.clear();
  }

}

function loopId(w: StepWriter, points: readonly P3[]): string {
  return w.add(`POLY_LOOP('',(${points.map((p) => w.point(p)).join(',')}))`);
}

function oriented(loop: readonly P3[], faceNormal: P3, keepSameSense: boolean): P3[] {
  const sign = vdot(newell(loop), faceNormal);
  const sameSense = sign > 0;
  return sameSense === keepSameSense ? [...loop] : [...loop].reverse();
}

/**
 * 世界坐标：局部 (u,v) 落在截面两轴上，第三轴按 t 沿杆轴推进。
 * 映射为左手系时（y 轴杆件），环向由 oriented() 统一按面法向校正。
 */
function toWorld(local: Vec2, axis: Axis, base: P3, dir: number, t: number): P3 {
  const { u, v } = SECTION_AXES[axis];
  const out: [number, number, number] = [base[0], base[1], base[2]];
  const index: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
  out[index[u]] = local.x;
  out[index[v]] = local.y;
  out[index[axis]] = base[index[axis]] + dir * t;
  return out;
}

function addCapFace(
  w: StepWriter,
  outer: readonly P3[],
  holes: readonly (readonly P3[])[],
  faceNormal: P3,
): string {
  const outerLoop = loopId(w, oriented(outer, faceNormal, true));
  const bounds = [w.add(`FACE_OUTER_BOUND('',${outerLoop},.T.)`)];
  for (const hole of holes) {
    const holeLoop = loopId(w, oriented(hole, faceNormal, false));
    bounds.push(w.add(`FACE_BOUND('',${holeLoop},.T.)`));
  }
  return w.add(`FACE('',(${bounds.join(',')}))`);
}

function addSideFace(
  w: StepWriter,
  s0: P3,
  s1: P3,
  e0: P3,
  e1: P3,
  outward: P3,
): string {
  const quad: P3[] = [s0, s1, e0, e1];
  const loop = vdot(newell(quad), outward) > 0 ? quad : [...quad].reverse();
  const bound = w.add(`FACE_OUTER_BOUND('',${loopId(w, loop)},.T.)`);
  return w.add(`FACE('',(${bound}))`);
}

/** 边对应的「从材料指向空腔」的局部法向；外环 CCW，孔环也按 CCW 存放。 */
function edgeOutwardLocal(a: Vec2, b: Vec2, isHole: boolean): { readonly x: number; readonly y: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return isHole ? { x: -dy, y: dx } : { x: dy, y: -dx };
}

function localToWorldDirection(normal: { readonly x: number; readonly y: number }, axis: Axis): P3 {
  const { u, v } = SECTION_AXES[axis];
  const index: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
  const out: [number, number, number] = [0, 0, 0];
  out[index[u]] = normal.x;
  out[index[v]] = normal.y;
  return out;
}

function memberSolid(
  w: StepWriter,
  label: string,
  spec: ProfileSpec,
  axis: Axis,
  start: P3,
  dir: number,
  trimStart: number,
  cutLength: number,
  miters: { readonly start?: MiterCut; readonly end?: MiterCut } = {},
): { readonly solidId: string; readonly faceCount: number } {
  const profile = buildProfile(spec);
  const base: P3 = [
    start[0] + (axis === 'x' ? dir * trimStart : 0),
    start[1] + (axis === 'y' ? dir * trimStart : 0),
    start[2] + (axis === 'z' ? dir * trimStart : 0),
  ];
  const axisDirection = vscale(UNIT[axis], dir);

  /**
   * 45° 斜切是沿截面一条轴的线性剪切：端点坐标 = 中心线端 ± 半宽。
   * 长点固定在 −u/−v 侧，与二维图的斜切线方向一致。
   */
  const shear = (cut: MiterCut | undefined): { readonly coord: 'u' | 'v'; readonly slope: number } | null => {
    if (cut === undefined) return null;
    const half = (cut.longPointMm - cut.shortPointMm) / 2;
    const coord = cut.view === 'top' ? 'u' : 'v';
    const halfDim = (coord === 'u' ? spec.width : spec.height) / 2;
    return halfDim > 0 ? { coord, slope: half / halfDim } : null;
  };
  const startShear = shear(miters.start);
  const endShear = shear(miters.end);
  const tAt = (p: Vec2, end: boolean): number => {
    const s = end ? endShear : startShear;
    if (s === null) return end ? cutLength : 0;
    const c = s.coord === 'u' ? p.x : p.y;
    // 起点端 t = c·slope；终点端整体平移 cutLength 且斜率反向（长点向外伸出）。
    return end ? cutLength - c * s.slope : c * s.slope;
  };
  const capOuter0 = profile.outer.map((p) => toWorld(p, axis, base, dir, tAt(p, false)));
  const capOuter1 = profile.outer.map((p) => toWorld(p, axis, base, dir, tAt(p, true)));
  const capsHoles0 = profile.holes.map((hole) => hole.map((p) => toWorld(p, axis, base, dir, tAt(p, false))));
  const capsHoles1 = profile.holes.map((hole) => hole.map((p) => toWorld(p, axis, base, dir, tAt(p, true))));

  const faces: string[] = [];
  faces.push(addCapFace(w, capOuter0, capsHoles0, vscale(axisDirection, -1)));
  faces.push(addCapFace(w, capOuter1, capsHoles1, axisDirection));

  const addSides = (points0: readonly P3[], points1: readonly P3[], local: readonly Vec2[], isHole: boolean): void => {
    for (let i = 0; i < local.length; i++) {
      const j = (i + 1) % local.length;
      const a = local[i]!;
      const b = local[j]!;
      if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-9) continue;
      const outward = localToWorldDirection(edgeOutwardLocal(a, b, isHole), axis);
      faces.push(addSideFace(w, points0[i]!, points0[j]!, points1[j]!, points1[i]!, outward));
    }
  };
  addSides(capOuter0, capOuter1, profile.outer, false);
  profile.holes.forEach((hole, index) => {
    addSides(capsHoles0[index]!, capsHoles1[index]!, hole, true);
  });

  const shell = w.add(`CLOSED_SHELL('',(${faces.join(',')}))`);
  const solidId = w.add(`FACETED_BREP(${stepString(label)},${shell})`);
  return { solidId, faceCount: faces.length };
}

function header(fileName: string, title: string, timestamp: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    `FILE_DESCRIPTION((${stepString('Mycad frame export; faceted planar B-rep, mm')}),'2;1');`,
    `FILE_NAME(${stepString(fileName)},${stepString(timestamp)},(${stepString('Mycad')}),(${stepString('Mycad')}),'mycad','mycad','');`,
    `FILE_SCHEMA((${stepString('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }')}));`,
    'ENDSEC;',
    'DATA;',
  ].join('\n');
}

function productStructure(w: StepWriter, title: string, solids: readonly string[]): void {
  const appContext = w.add(
    "APPLICATION_CONTEXT('core data for automotive mechanical design processes')",
  );
  w.add("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000," + appContext + ')');
  const productContext = w.add(`PRODUCT_CONTEXT('',${appContext},'mechanical')`);
  const definitionContext = w.add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appContext},'design')`);
  const product = w.add(`PRODUCT(${stepString(title)},${stepString(title)},'',(${productContext}))`);
  const formation = w.add(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',${product},.NOT_KNOWN.)`);
  const definition = w.add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
  const shape = w.add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);

  const millimeter = w.add('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))');
  const radian = w.add('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))');
  const uncertainty = w.add(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-6),${millimeter},'distance_accuracy_value','confusion accuracy')`,
  );
  const context = w.add(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) ` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((${millimeter},${radian})) REPRESENTATION_CONTEXT('context','3D'))`,
  );
  const representation = w.add(`FACETED_BREP_SHAPE_REPRESENTATION(${stepString(title)},(${solids.join(',')}),${context})`);
  w.add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
}

export function frameToStep(model: FrameModel, options: StepExportOptions = {}): StepExportResult {
  if (model.members.length === 0) {
    throw new RangeError('框架没有杆件，无法导出 STEP；请先补 members');
  }
  const requestedName = options.fileName ?? 'mycad-frame.step';
  const fileName = /^[\x20-\x7E]+$/.test(requestedName) ? requestedName : 'mycad-frame.step';
  const title = asciiTitle(options.title ?? 'Mycad Frame');
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const timestamp = `${date}T00:00:00`;

  const w = new StepWriter();
  const legend: StepEntityRow[] = [];
  const solids: string[] = [];
  let faces = 0;
  const warnings: string[] = [];
  const miterByMember = new Map<string, { start?: MiterCut; end?: MiterCut }>();
  for (const joint of options.plan?.joints ?? []) {
    for (const cut of joint.miters ?? []) {
      const bucket = miterByMember.get(cut.memberId) ?? {};
      bucket[cut.end] = cut;
      miterByMember.set(cut.memberId, bucket);
    }
  }
  let miteredMembers = 0;

  let nonAsciiNames = 0;
  model.members.forEach((member, index) => {
    const profile = model.profiles.find((p) => p.id === member.profileId);
    if (profile === undefined) {
      throw new RangeError(`杆件 ${member.id} 引用了不存在的型材 ${member.profileId}`);
    }
    const label = `M${index + 1}`;
    w.resetPoints();
    const dir = member.end[member.axis] >= member.start[member.axis] ? 1 : -1;
    const solid = memberSolid(
      w,
      label,
      profile.spec,
      member.axis,
      [member.start.x, member.start.y, member.start.z],
      dir,
      member.trimStart,
      member.cutLength,
      miterByMember.get(member.id) ?? {},
    );
    if (miterByMember.has(member.id)) miteredMembers += 1;
    solids.push(solid.solidId);
    faces += solid.faceCount;
    w.resetPoints();
    legend.push({
      label,
      memberId: member.id,
      profileId: member.profileId,
      cutLengthMm: member.cutLength,
    });
    if (member.id !== label) nonAsciiNames += 1;
  });
  if (nonAsciiNames > 0) {
    warnings.push(`${nonAsciiNames} 根杆件在 STEP 中以 M1..Mn 命名，原名见 legend`);
  }

  productStructure(w, title, solids);

  const text = [
    header(fileName, title, timestamp),
    w.text(),
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');

  return {
    text,
    fileName,
    solids: model.members.length,
    miteredMembers,
    faces,
    points: w.pointCount,
    legend,
    warnings,
  };
}
