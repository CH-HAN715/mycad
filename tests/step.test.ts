import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrame, parseFrameInput } from '../src/frame/model.ts';
import { planConnections } from '../src/connect/plan.ts';
import { STEP_PROVENANCE, frameToStep } from '../src/io/step.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

const P20 = {
  id: 'p20',
  spec: { width: 20, height: 20 },
  material: { name: '6063-T5', densityKgPerM3: 2700 },
};

function frameOf(members: unknown[]): ReturnType<typeof buildFrame> {
  return buildFrame(parseFrameInput({ profiles: [P20], members }));
}

const beam = (id: string, length: number) => ({ id, profileId: 'p20', start: [0, 0, 0], end: [length, 0, 0] });

/** 收集指定实体（M1..Mn）闭包内的点坐标，避免不同杆件的包围盒互相干扰。 */
function solidPoints(text: string, label: string): number[][] {
  const entities = new Map<string, string>();
  for (const m of text.matchAll(/^(#\d+)=(.+);$/gm)) entities.set(m[1]!, m[2]!);
  const solid = [...entities.entries()].find(([, body]) => body.startsWith(`FACETED_BREP('${label}',`))!;
  const root = /,(#\d+)\)$/.exec(solid[1]!)![1]!;
  const seen = new Set<string>();
  const queue = [root];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const ref of entities.get(id)?.matchAll(/#\d+/g) ?? []) queue.push(ref[0]);
  }
  return [...seen]
    .map((id) => /^CARTESIAN_POINT\('',\(([^)]*)\)\)$/.exec(entities.get(id) ?? ''))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]!.split(',').map(Number));
}

/** 收集所有 CARTESIAN_POINT 的坐标。 */
function points(text: string): number[][] {
  return [...text.matchAll(/CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].map((m) =>
    m[1]!.split(',').map((value) => Number(value)),
  );
}

describe('mycad STEP 结构', () => {
  it('ISO 10303-21 骨架完整，引用全部可解析且纯 ASCII', () => {
    const model = frameOf([beam('A', 600)]);
    const out = frameToStep(model, { date: '2026-11-13' });
    assert.ok(out.text.startsWith('ISO-10303-21;\nHEADER;\n'));
    assert.ok(out.text.endsWith('ENDSEC;\nEND-ISO-10303-21;\n'));
    assert.match(out.text, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN/);
    assert.match(out.text, /FILE_NAME\('mycad-frame\.step','2026-11-13T00:00:00'/);
    assert.match(out.text, /FACETED_BREP_SHAPE_REPRESENTATION/);
    assert.equal(/[^\x00-\x7F]/.test(out.text), false, 'STEP 正文必须纯 ASCII');
    assert.equal(out.solids, 1);
    assert.equal(out.faces, 6);
    assert.equal(out.points, 8);

    const data = out.text.split('DATA;')[1]!.split('ENDSEC;')[0]!;
    const defined = new Set([...data.matchAll(/^(#\d+)=/gm)].map((m) => m[1]!));
    const referenced = [...data.matchAll(/#\d+/g)].map((m) => m[0]);
    const missing = [...new Set(referenced.filter((ref) => !defined.has(ref)))];
    assert.deepEqual(missing, [], '所有实体引用必须有定义');
  });

  it('20x20 方管沿 x 拉伸：8 个点、6 个面，坐标覆盖 0..600 与 ±10', () => {
    const model = frameOf([beam('A', 600)]);
    const out = frameToStep(model);
    const pts = points(out.text);
    assert.equal(pts.length, 8);
    assert.equal(Math.min(...pts.map((p) => p[0]!)), 0);
    assert.equal(Math.max(...pts.map((p) => p[0]!)), 600);
    assert.deepEqual([...new Set(pts.map((p) => p[1]!))].sort((a, b) => a - b), [-10, 10]);
    assert.deepEqual([...new Set(pts.map((p) => p[2]!))].sort((a, b) => a - b), [-10, 10]);
  });

  it('trimStart 后实体从物理端面起算（x 从 10 到 600）', () => {
    const model = frameOf([
      { id: 'A', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0], trimStart: 10 },
    ]);
    const out = frameToStep(model);
    const xs = points(out.text).map((p) => p[0]!);
    assert.equal(Math.min(...xs), 10);
    assert.equal(Math.max(...xs), 600);
    assert.equal(out.legend[0]!.cutLengthMm, 590);
  });

  it('z 轴反向杆件仍覆盖 0..750（start 在顶端，dir = -1）', () => {
    const model = frameOf([
      { id: 'A', profileId: 'p20', start: [0, 0, 750], end: [0, 0, 0] },
    ]);
    const out = frameToStep(model);
    const zs = points(out.text).map((p) => p[2]!);
    assert.equal(Math.min(...zs), 0);
    assert.equal(Math.max(...zs), 750);
  });

  it('y 轴杆件按 u=x、v=z 映射，截面落在 x/z 的 ±10 内', () => {
    const model = frameOf([
      { id: 'A', profileId: 'p20', start: [0, 0, 0], end: [0, 600, 0] },
    ]);
    const out = frameToStep(model);
    const pts = points(out.text);
    assert.deepEqual([...new Set(pts.map((p) => p[1]!))].sort((a, b) => a - b), [0, 600]);
    for (const p of pts) {
      assert.ok(Math.abs(p[0]!) <= 10 + 1e-9);
      assert.ok(Math.abs(p[2]!) <= 10 + 1e-9);
    }
  });

  it('每个环至少 3 点，且每条无向边恰好被两个环共享（闭合壳体）', () => {
    const model = buildFrame(
      parseFrameInput({
        profiles: [
          {
            id: 'p20',
            spec: {
              width: 20,
              height: 20,
              slot: { opening: 6, depth: 4.5, headWidth: 9, headStart: 2 },
              bore: { radius: 2.5, segments: 8 },
            },
          },
        ],
        members: [beam('A', 600), { id: 'B', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] }],
      }),
    );
    const out = frameToStep(model);
    assert.equal(/[^\x00-\x7F]/.test(out.text), false);
    const loops = [...out.text.matchAll(/POLY_LOOP\('',\(([^)]*)\)\)/g)].map((m) =>
      m[1]!.split(',').map((id) => id.trim()),
    );
    for (const loop of loops) assert.ok(loop.length >= 3, `环点数不足：${loop.join(',')}`);
    const edges = new Map<string, number>();
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % loop.length]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    const bad = [...edges.entries()].filter(([, count]) => count !== 2);
    assert.deepEqual(bad, [], '每条边必须被两个面共享');

    const miterModel = buildFrame(
      parseFrameInput({
        profiles: [{ id: 'p40', spec: { width: 40, height: 40 } }],
        members: [
          { id: 'A', profileId: 'p40', start: [0, 0, 0], end: [600, 0, 0] },
          { id: 'B', profileId: 'p40', start: [0, 0, 0], end: [0, 0, 750] },
        ],
      }),
    );
    const mitered = frameToStep(miterModel, { plan: planConnections(miterModel, { cornerStrategy: 'miter45' }) });
    const miterLoops = [...mitered.text.matchAll(/POLY_LOOP\('',\(([^)]*)\)\)/g)].map((m) =>
      m[1]!.split(',').map((id) => id.trim()),
    );
    const miterEdges = new Map<string, number>();
    for (const loop of miterLoops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i]!;
        const b = loop[(i + 1) % loop.length]!;
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        miterEdges.set(key, (miterEdges.get(key) ?? 0) + 1);
      }
    }
    assert.deepEqual([...miterEdges.entries()].filter(([, count]) => count !== 2), [], '斜切壳体同样闭合');
  });

  it('中心孔作为内环进入两端面，并生成孔壁侧面', () => {    const model = buildFrame(
      parseFrameInput({
        profiles: [{ id: 'p20', spec: { width: 20, height: 20, bore: { radius: 2.5, segments: 8 } } }],
        members: [beam('A', 600)],
      }),
    );
    const out = frameToStep(model);
    assert.equal(out.faces, 2 + 4 + 8, '两盖面 + 四外边 + 八条孔壁');
    assert.equal([...out.text.matchAll(/FACE_BOUND\(/g)].length, 2);
    assert.match(STEP_PROVENANCE.limitations.join('\n'), /钻孔/);
  });

  it('空框架拒绝导出；中文杆件名转 M1 并给出告警与 legend', () => {
    assert.throws(() => frameToStep(frameOf([])), /没有杆件/);
    const out = frameToStep(frameOf([{ id: '横梁', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] }]));
    assert.match(out.text, /FACETED_BREP\('M1'/);
    assert.doesNotMatch(out.text, /横梁/);
    assert.equal(out.legend[0]!.memberId, '横梁');
    assert.equal(out.warnings.length, 1);
  });
});

describe('mycad STEP 45° 斜切端', () => {
  const L40 = { id: 'p40', spec: { width: 40, height: 40 }, material: { name: '6063-T5', densityKgPerM3: 2700 } };
  const cornerFrame = () =>
    buildFrame(
      parseFrameInput({
        profiles: [L40],
        members: [
          { id: 'A', profileId: 'p40', start: [0, 0, 0], end: [600, 0, 0] },
          { id: 'B', profileId: 'p40', start: [0, 0, 0], end: [0, 0, 750] },
        ],
      }),
    );

  it('斜切端按剪切平面建模：长点在 -u/-v 侧，实体伸出中心线半宽', () => {
    const model = cornerFrame();
    const plan = planConnections(model, { cornerStrategy: 'miter45' });
    const out = frameToStep(model, { plan, date: '2026-11-13' });
    assert.equal(out.miteredMembers, 2);
    const a = solidPoints(out.text, 'M1');
    assert.equal(Math.min(...a.map((p) => p[0]!)), -20, 'A 的长点伸出到 x=-20');
    assert.equal(Math.max(...a.map((p) => p[0]!)), 600, 'A 的方切端仍在 x=600');
    const b = solidPoints(out.text, 'M2');
    assert.equal(Math.min(...b.map((p) => p[2]!)), -20, 'B 的长点伸出到 z=-20');
    assert.equal(Math.max(...b.map((p) => p[2]!)), 750);
  });

  it('不给 plan 时按方切端，端面停在中心线端点上', () => {
    const out = frameToStep(cornerFrame());
    assert.equal(out.miteredMembers, 0);
    const a = solidPoints(out.text, 'M1');
    assert.equal(Math.min(...a.map((p) => p[0]!)), 0);
    assert.equal(Math.max(...a.map((p) => p[0]!)), 600);
  });
});

describe('mycad CLI step', () => {
  it('写文件并返回 JSON 统计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mycad-step-'));
    const input = join(dir, 'frame.json');
    const output = join(dir, 'frame.step');
    writeFileSync(
      input,
      JSON.stringify({
        frame: {
          profiles: [P20],
          members: [beam('A', 600), { id: 'B', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] }],
        },
        options: { cornerStrategy: 'miter45' },
      }),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CLI, 'step', '--file', input, '--out', output, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      command: string;
      solids: number;
      miteredMembers: number;
      faces: number;
      provenance: { format: string };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.command, 'step');
    assert.equal(payload.solids, 2);
    assert.equal(payload.miteredMembers, 2);
    assert.equal(payload.faces, 12);
    assert.match(payload.provenance.format, /FACETED_BREP/);
    const text = readFileSync(output, 'utf8');
    assert.match(text, /FACETED_BREP\('M1'/);
    assert.match(text, /FACETED_BREP\('M2'/);
  });

  it('缺少 --out 时报用法错误', () => {
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CLI, 'step', '--file', '-', '--json'],
      { encoding: 'utf8', input: '' },
    );
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'E_USAGE');
    assert.match(payload.error.message, /--out/);
  });
});
