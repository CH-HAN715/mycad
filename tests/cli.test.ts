import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli/main.ts', import.meta.url));
const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
  .version;

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], input?: string): RunResult {
  const options: { encoding: 'utf8'; input?: string } = { encoding: 'utf8' };
  if (input !== undefined) options.input = input;
  const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], options);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const RECT = JSON.stringify({ outer: [[0, 0], [40, 0], [40, 20], [0, 20]], holes: [] });

describe('mycad section', () => {
  it('从 stdin 读矩形并输出可解析的 JSON', () => {
    const result = run(['section', '--json'], RECT);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      units: Record<string, string>;
      result: { area: number; centroid: { x: number; y: number }; ix: number };
      provenance: { disclaimer: string; formulas: readonly string[] };
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.units['area'], 'mm^2');
    assert.equal(payload.units['secondMoment'], 'mm^4');
    assert.equal(payload.result.area, 800);
    assert.equal(payload.result.centroid.x, 20);
    assert.equal(payload.result.centroid.y, 10);
    assert.ok(Math.abs(payload.result.ix - 26666.666666666668) < 1e-6);
    assert.ok(payload.provenance.formulas.length > 0);
    assert.ok(payload.provenance.disclaimer.length > 0);
  });

  it('接受 {"x":..,"y":..} 形式的点', () => {
    const input = JSON.stringify({
      outer: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 20 }, { x: 0, y: 20 }],
    });
    const result = run(['section', '--json'], input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal((JSON.parse(result.stdout) as { result: { area: number } }).result.area, 800);
  });

  it('--profile 读取参数化型材规格并输出模型元数据', () => {
    const spec = JSON.stringify({
      width: 20,
      height: 20,
      slot: { opening: 6, depth: 5.5, headWidth: 8, headStart: 2 },
      bore: { radius: 2.25, sagitta: 0.01 },
    });
    const result = run(['section', '--json', '--profile', '-'], spec);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      result: { area: number; ix: number };
      profile: {
        meta: { slotCount: number; boreSegments: number; slotFaces: readonly string[] };
        provenance: { notModeled: readonly string[] };
      };
    };
    assert.equal(payload.profile.meta.slotCount, 4);
    assert.equal(payload.profile.meta.boreSegments, 34);
    assert.deepEqual(payload.profile.meta.slotFaces, ['bottom', 'right', 'top', 'left']);
    assert.ok(payload.profile.provenance.notModeled.length > 0);
    assert.ok(payload.result.area > 200 && payload.result.area < 230);
    assert.ok(payload.result.ix > 8000 && payload.result.ix < 9000);
  });

  it('--profile 的未知字段被拒绝', () => {
    const spec = JSON.stringify({ width: 20, height: 20, dimensons: {} });
    const result = run(['section', '--json', '--profile', '-'], spec);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { code: string; message: string } };
    assert.equal(payload.error.code, 'E_INPUT_GEOMETRY');
    assert.ok(payload.error.message.includes('未知字段'));
  });

  it('--profile 与 --file 不能同时使用', () => {
    const result = run(['section', '--json', '--profile', '-', '--file', '/tmp/x.json'], '{}');
    assert.equal(result.status, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'E_USAGE');
  });

  it('--preset 用内置算例，孔洞自动扣除', () => {
    const result = run(['section', '--json', '--preset', 'tube-40x20-t3']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as { result: { area: number; ix: number }; input: { source: string } };
    assert.equal(payload.result.area, 324);
    assert.equal(payload.result.ix, 18892);
    assert.equal(payload.input.source, 'preset:tube-40x20-t3');
  });

  it('非法 JSON 返回退出码 2 与结构化错误', () => {
    const result = run(['section', '--json'], '{not json');
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { ok: boolean; error: { code: string; hint: string } };
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'E_INPUT_JSON');
    assert.ok(payload.error.hint.length > 0);
  });

  it('缺少 outer 返回 E_INPUT_SHAPE', () => {
    const result = run(['section', '--json'], '{"holes": []}');
    assert.equal(result.status, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'E_INPUT_SHAPE');
  });

  it('顶点不足返回 E_INPUT_GEOMETRY', () => {
    const result = run(['section', '--json'], '{"outer": [[0,0],[10,0]]}');
    assert.equal(result.status, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'E_INPUT_GEOMETRY');
  });

  it('自交轮廓返回 reason=self_intersection', () => {
    const result = run(['section', '--json'], '{"outer": [[0,0],[10,10],[10,0],[0,10]]}');
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { code: string; reason: string } };
    assert.equal(payload.error.code, 'E_INPUT_GEOMETRY');
    assert.equal(payload.error.reason, 'self_intersection');
  });

  it('孔洞在外轮廓之外返回 reason=hole_outside', () => {
    const input = JSON.stringify({
      outer: [[-20, -10], [20, -10], [20, 10], [-20, 10]],
      holes: [[[95, 95], [105, 95], [105, 105], [95, 105]]],
    });
    const result = run(['section', '--json'], input);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { code: string; reason: string } };
    assert.equal(payload.error.code, 'E_INPUT_GEOMETRY');
    assert.equal(payload.error.reason, 'hole_outside');
  });

  it('未知算例返回 E_USAGE 并列出可用 id', () => {
    const result = run(['section', '--json', '--preset', 'nope']);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { code: string; hint: string } };
    assert.equal(payload.error.code, 'E_USAGE');
    assert.ok(payload.error.hint.includes('rect-40x20'));
  });
});

describe('mycad bench', () => {
  it('全部手算算例通过', () => {
    const result = run(['bench', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      ok: boolean;
      summary: { total: number; passed: number; failed: number };
      cases: readonly { id: string; ok: boolean; maxRelError: number }[];
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.summary.failed, 0);
    assert.equal(payload.summary.total, 5);
    assert.equal(payload.summary.passed, 5);
    for (const testCase of payload.cases) {
      assert.equal(testCase.ok, true, testCase.id);
      assert.ok(testCase.maxRelError < 1e-9, `${testCase.id} 最大相对误差 ${testCase.maxRelError}`);
    }
  });

  it('人类可读模式输出表头与汇总', () => {
    const result = run(['bench']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('最大相对误差'));
    assert.ok(result.stdout.includes('通过 5'));
  });
});

describe('mycad frame / bom / cut', () => {
  const FRAME = JSON.stringify({
    profiles: [
      { id: 'p20', spec: { width: 20, height: 20 }, material: { name: '6063-T5', densityKgPerM3: 2700 } },
    ],
    members: [
      { id: 'h1', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
      { id: 'h2', profileId: 'p20', start: [0, 400, 0], end: [600, 400, 0] },
      { id: 'v1', profileId: 'p20', start: [0, 0, 0], end: [0, 400, 0] },
      { id: 'v2', profileId: 'p20', start: [600, 0, 0], end: [600, 400, 0] },
    ],
  });

  it('frame 输出杆件长度与关节', () => {
    const result = run(['frame', '--json'], FRAME);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      model: {
        members: readonly { id: string; cutLengthMm: number }[];
        joints: readonly { memberCount: number }[];
      };
    };
    assert.equal(payload.model.members.length, 4);
    assert.equal(payload.model.joints.length, 4);
    for (const joint of payload.model.joints) assert.equal(joint.memberCount, 2);
  });

  it('bom 输出下料清单与方案', () => {
    const result = run(['bom', '--json', '--stock', '6000', '--kerf', '3'], FRAME);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      bom: { cutList: readonly { lengthMm: number; quantity: number }[]; stockPlan: { bars: readonly unknown[] } };
    };
    assert.equal(payload.bom.cutList.length, 2);
    assert.equal(payload.bom.stockPlan.bars.length, 1);
  });

  it('cut 拒绝缺少 --kerf，不静默按 0', () => {
    const result = run(['cut', '--json', '--stock', '6000'], '[{"id":"a","lengthMm":600,"quantity":1}]');
    assert.equal(result.status, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'E_USAGE');
  });

  it('frame 拒绝斜杆并给出结构化 reason', () => {
    const input = JSON.stringify({
      profiles: [{ id: 'p', spec: { width: 20, height: 20 } }],
      members: [{ id: 'm', profileId: 'p', start: [0, 0, 0], end: [10, 10, 0] }],
    });
    const result = run(['frame', '--json'], input);
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout) as { error: { code: string; reason: string } };
    assert.equal(payload.error.code, 'E_INPUT_FRAME');
    assert.equal(payload.error.reason, 'not_axis_aligned');
  });
});

describe('mycad 元命令', () => {
  it('--version 与 package.json 一致', () => {
    const result = run(['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `mycad ${PACKAGE_VERSION}`);
  });

  it('help 列出已实现的命令', () => {
    const result = run(['help']);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('mycad section'));
    assert.ok(result.stdout.includes('mycad report'));
    assert.ok(result.stdout.includes('mycad frame'));
    assert.ok(result.stdout.includes('mycad bom'));
    assert.ok(result.stdout.includes('mycad cut'));
    assert.ok(result.stdout.includes('mycad bench'));
  });

  it('未知命令返回 E_USAGE', () => {
    const result = run(['frobnicate', '--json']);
    assert.equal(result.status, 2);
    assert.equal((JSON.parse(result.stdout) as { error: { code: string } }).error.code, 'E_USAGE');
  });
});
