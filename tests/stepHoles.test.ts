import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFrame, parseFrameInput } from '../src/frame/model.ts';
import { DEFAULT_CONNECT_RULES } from '../src/connect/rules.ts';
import type { ConnectPlan, ConnectorHole } from '../src/connect/plan.ts';
import { frameToStepWithHoles } from '../src/io/stepHoles.ts';
import { frameToStep } from '../src/io/step.ts';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));

const P20 = { id: 'p20', spec: { width: 20, height: 20 }, material: { name: '6063-T5', densityKgPerM3: 2700 } };

function frameOf(members: unknown[], spec: unknown = P20.spec): ReturnType<typeof buildFrame> {
  return buildFrame(parseFrameInput({ profiles: [{ id: 'p20', spec }], members }));
}

const beam = (id: string, length: number) => ({ id, profileId: 'p20', start: [0, 0, 0], end: [length, 0, 0] });

function hole(overrides: Record<string, unknown> = {}): ConnectorHole {
  return {
    memberId: 'A',
    at: 'start',
    face: 'left',
    fromJointEndMm: 15,
    alongStartMm: null,
    localU: -10,
    localV: 0,
    boltAxis: 'y',
    boltSeries: 'M5',
    diameterMm: 5,
    clearanceDrillMm: 5.5,
    tapDrillMm: 4.2,
    depthMm: null,
    ...overrides,
  } as ConnectorHole;
}

function fakePlan(holes: ConnectorHole[], miters: unknown[] = []): ConnectPlan {
  return {
    joints: [{ index: 0, point: { x: 0, y: 0, z: 0 }, kind: 'corner', strategy: 'bracket', memberCount: 1, holes, miters }],
    rules: DEFAULT_CONNECT_RULES,
    endCaps: [],
  } as unknown as ConnectPlan;
}

interface SolidMesh {
  readonly loops: number[][][];
}

function parseSolid(text: string, label: string): SolidMesh {
  const entities = new Map<string, string>();
  for (const m of text.matchAll(/^(#\d+)=(.+);$/gm)) entities.set(m[1]!, m[2]!);
  const solid = [...entities.entries()].find(([, body]) => body.startsWith(`FACETED_BREP('${label}',`))!;
  const shellId = /,(#\d+)\)$/.exec(solid[1]!)![1]!;
  const shell = entities.get(shellId)!;
  const loops: number[][][] = [];
  for (const faceRef of shell.matchAll(/#\d+/g)) {
    const face = entities.get(faceRef[0])!;
    for (const boundRef of face.matchAll(/#\d+/g)) {
      const bound = entities.get(boundRef[0])!;
      const loopId = /#\d+/.exec(bound)![0];
      const loop = entities.get(loopId)!;
      const points: number[][] = [];
      for (const pointRef of loop.matchAll(/#\d+/g)) {
        const point = entities.get(pointRef[0])!;
        const coords = /CARTESIAN_POINT\('',\(([^)]*)\)\)/.exec(point)![1]!;
        points.push(coords.split(',').map(Number));
      }
      loops.push(points);
    }
  }
  return { loops };
}

function signedVolume(mesh: SolidMesh): number {
  let volume = 0;
  for (const loop of mesh.loops) {
    const [a, b, c] = loop;
    assert.ok(a !== undefined && b !== undefined && c !== undefined, '三角面必须 3 点');
    const cross = [b[1]! * c[2]! - b[2]! * c[1]!, b[2]! * c[0]! - b[0]! * c[2]!, b[0]! * c[1]! - b[1]! * c[0]!];
    volume += (a[0]! * cross[0]! + a[1]! * cross[1]! + a[2]! * cross[2]!) / 6;
  }
  return volume;
}

function assertClosed(mesh: SolidMesh): void {
  const edges = new Map<string, number>();
  for (const loop of mesh.loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]!.join(',');
      const b = loop[(i + 1) % loop.length]!.join(',');
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  assert.deepEqual([...edges.entries()].filter(([, count]) => count !== 2), [], '每条边必须被两个面共享');
}

const polygonArea = (segments: number, radius: number): number =>
  0.5 * segments * radius * radius * Math.sin((2 * Math.PI) / segments);

describe('mycad STEP 钻孔布尔', () => {
  it('单个通孔按 24 段圆柱扣除，体积与手算一致', async () => {
    const model = frameOf([beam('A', 600)]);
    const result = await frameToStepWithHoles(model, fakePlan([hole()]), { date: '2026-11-13' });
    assert.equal(result.holesModeled, 1);
    const expectedRemoved = polygonArea(24, 2.75) * 20;
    const expected = 20 * 20 * 600 - expectedRemoved;
    assert.ok(result.volumeMm3 !== null);
    assert.ok(
      Math.abs(result.volumeMm3 - expected) / expected < 1e-6,
      `体积 ${result.volumeMm3} 与手算 ${expected} 不符`,
    );
    const mesh = parseSolid(result.text, 'M1');
    assertClosed(mesh);
    // 三角网格的有向体积应与布尔内核一致（同时校验绕序与轴向映射）
    assert.ok(Math.abs(signedVolume(mesh) - result.volumeMm3) / result.volumeMm3 < 1e-4);
  });

  it('孔穿过中心孔时扣除体积小于整圆柱（布尔与空腔求交）', async () => {
    const model = frameOf([beam('A', 600)], { width: 20, height: 20, bore: { radius: 2.5 } });
    const result = await frameToStepWithHoles(model, fakePlan([hole()]), { date: '2026-11-13' });
    const fullCylinder = polygonArea(24, 2.75) * 20;
    const prism = Number(model.profiles[0]!.area) * 600;
    assert.ok(result.volumeMm3 !== null);
    const removed = prism - result.volumeMm3;
    assert.ok(removed > 0 && removed < fullCylinder, '穿过中心孔时扣除量应小于整圆柱');
    assertClosed(parseSolid(result.text, 'M1'));
  });

  it('斜切与钻孔可同时存在：体积守恒且壳体闭合', async () => {
    const model = buildFrame(
      parseFrameInput({
        profiles: [{ id: 'p20', spec: { width: 20, height: 20 } }],
        members: [beam('A', 600), { id: 'B', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] }],
      }),
    );
    const plan = fakePlan([hole()], [
      { memberId: 'A', end: 'start', angleDeg: 45, longPointMm: 610, shortPointMm: 590, view: 'side' },
    ]);
    const result = await frameToStepWithHoles(model, plan, { date: '2026-11-13' });
    assert.equal(result.miteredMembers, 1);
    assert.equal(result.holesModeled, 1);
    const mesh = parseSolid(result.text, 'M1');
    assertClosed(mesh);
    const expectedM1 = 20 * 20 * 600 - polygonArea(24, 2.75) * 20;
    assert.ok(Math.abs(signedVolume(mesh) - expectedM1) / expectedM1 < 1e-4);
    assert.ok(Math.min(...mesh.loops.flatMap((loop) => loop.map((p) => p[0]!))) < 0, '斜切端应伸出 x=0');
  });

  it('y 轴杆件的左手映射会翻转三角绕序，体积仍为正', async () => {
    const model = buildFrame(
      parseFrameInput({
        profiles: [{ id: 'p20', spec: { width: 20, height: 20 } }],
        members: [{ id: 'B', profileId: 'p20', start: [0, 0, 0], end: [0, 600, 0] }],
      }),
    );
    const result = await frameToStepWithHoles(
      model,
      fakePlan([hole({ memberId: 'B', localU: -10, localV: 0 })]),
      { date: '2026-11-13' },
    );
    const mesh = parseSolid(result.text, 'M1');
    assertClosed(mesh);
    assert.ok(Math.abs(signedVolume(mesh) - result.volumeMm3!) / result.volumeMm3! < 1e-4);
    assert.ok(Math.max(...mesh.loops.flatMap((loop) => loop.map((p) => p[1]!))) === 600);
  });

  it('盲孔与无直径孔拒绝建模，不静默按通孔处理', async () => {
    const model = frameOf([beam('A', 600)]);
    await assert.rejects(
      frameToStepWithHoles(model, fakePlan([hole({ depthMm: 5 })]), { date: '2026-11-13' }),
      /盲孔/,
    );
    await assert.rejects(
      frameToStepWithHoles(model, fakePlan([hole({ clearanceDrillMm: null, diameterMm: null })]), {
        date: '2026-11-13',
      }),
      /没有可用直径/,
    );
  });

  it('没有孔的框架退回普通导出，不加载布尔内核', async () => {
    const model = frameOf([beam('A', 600)]);
    const result = await frameToStepWithHoles(model, fakePlan([]), { date: '2026-11-13' });
    assert.equal(result.holesModeled, 0);
    assert.equal(result.volumeMm3, null);
    assert.equal(result.text, frameToStep(model, { date: '2026-11-13' }).text);
  });
});

describe('mycad CLI step --holes', () => {
  it('按连接方案扣孔并返回体积与来源', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mycad-step-holes-'));
    const input = join(dir, 'frame.json');
    const output = join(dir, 'frame.step');
    writeFileSync(
      input,
      JSON.stringify({
        profiles: [
          {
            id: 'p20',
            spec: {
              width: 20,
              height: 20,
              slot: { opening: 6.15, depth: 4.5, headWidth: 9, headStart: 2 },
              bore: { radius: 2.5 },
            },
          },
        ],
        members: [
          { id: 'A', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
          { id: 'B', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] },
        ],
      }),
      'utf8',
    );
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CLI, 'step', '--file', input, '--out', output, '--holes', '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      holesModeled: number;
      volumeMm3: number;
      provenance: { tools?: string; assumptions: string[] };
    };
    assert.ok(payload.holesModeled >= 4);
    assert.ok(payload.volumeMm3 > 0);
    assert.match(payload.provenance.tools ?? '', /manifold-3d/);
    assert.equal(payload.provenance.assumptions.some((item) => item.startsWith('钻孔不从')), false);
    const text = readFileSync(output, 'utf8');
    assert.ok([...text.matchAll(/CARTESIAN_POINT/g)].length > 200);
  });

  it('--holes 只允许 step 使用', () => {
    const result = spawnSync(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', CLI, 'frame', '--file', '-', '--holes', '--json'],
      { encoding: 'utf8', input: '{"profiles":[],"members":[]}' },
    );
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { message: string } };
    assert.match(payload.error.message, /--holes/);
  });
});
