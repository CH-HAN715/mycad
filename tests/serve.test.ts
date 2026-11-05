import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startServe } from '../src/serve/server.ts';
import type { ServeHandle } from '../src/serve/server.ts';

let handle: ServeHandle;
let base: string;

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const FRAME = {
  profiles: [
    {
      id: 'p20',
      spec: { width: 20, height: 20, slot: { opening: 6.15, depth: 4.5, headWidth: 9, headStart: 2 }, bore: { radius: 2.5 } },
      material: { name: '6063', densityKgPerM3: 2700 },
    },
  ],
  members: [
    { id: 'beam', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
    { id: 'legL', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] },
    { id: 'mid', profileId: 'p20', start: [300, 0, 750], end: [300, 0, 0] },
    { id: 'top', profileId: 'p20', start: [0, 0, 750], end: [600, 0, 750] },
  ],
};

describe('mycad serve', () => {
  before(async () => {
    handle = await startServe({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });
  after(() => handle.close());

  it('GET / 返回页面', async () => {
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes('mycad'), '页面应包含标题');
  });

  it('GET /api/presets 返回内置预设', async () => {
    const r = await fetch(`${base}/api/presets`);
    const j = (await r.json()) as { ok: boolean; presets: { id: string }[] };
    assert.equal(j.ok, true);
    assert.deepEqual(j.presets.map((p) => p.id), ['eu2020', 'eu4040']);
  });

  it('POST /api/section 预设口径与 CLI 同源', async () => {
    const { status, json } = await post('section', { presetProfile: 'eu2020' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const result = json.result as { area: number; ix: number };
    assert.ok(result.area > 0);
    assert.ok(result.ix > 7200, '理想化 Ix 应偏大（空心腔未建模）');
    assert.ok(json.profilePreset !== undefined, '预设应附带厂家值');
  });

  it('POST /api/frame 与 /api/connect：T 接被识别', async () => {
    const frame = await post('frame', FRAME);
    assert.equal(frame.json.ok, true);
    const model = frame.json.model as { joints: { ends: unknown[] }[] };
    assert.ok(model.joints.length >= 3);

    const connect = await post('connect', FRAME);
    assert.equal(connect.json.ok, true);
    const plan = connect.json.plan as { joints: { kind: string }[] };
    assert.ok(plan.joints.some((j) => j.kind === 'tee'), '中立柱端点应被判为 T 接');
  });

  it('POST /api/bom：stock/kerf 成对校验', async () => {
    const ok = await post('bom', { frame: FRAME, options: { stockMm: 6000, kerfMm: 3 } });
    assert.equal(ok.json.ok, true);
    const partial = await post('bom', { frame: FRAME, options: { stockMm: 6000 } });
    assert.equal(partial.json.ok, false);
    assert.equal(partial.status, 400);
  });

  it('POST /api/check：示例载荷给出结果', async () => {
    const { status, json } = await post('check', {
      case: 'ss_udl',
      lengthMm: 600,
      eMpa: 70000,
      eSource: '米思米样本 6063-T5',
      section: { areaMm2: 159, iMm4: 7200, wMm3: 720, bendingNote: '厂家公布值' },
      bendingAxis: 'x',
      qNPerMm: 0.5,
      allowableMpa: 80,
      allowableSource: '工程惯例，非规范条文',
      deflectionRatioLimit: 250,
      deflectionSource: '工程惯例，非规范条文',
    });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    const result = json.result as { verdict: string; formulas: unknown[] };
    assert.ok(['pass', 'fail', 'incomplete'].includes(result.verdict), `verdict 非法：${result.verdict}`);
    assert.ok(result.formulas.length >= 3);
  });

  it('POST /api/dxf-section 返回 DXF 文本', async () => {
    const r = await fetch(`${base}/api/dxf-section`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ presetProfile: 'eu2020' }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.ok(text.includes('LINE'));
    assert.ok(text.includes('EOF'));
  });

  it('GET /vendor/three.module.js 本地提供渲染库（无 CDN）', async () => {
    const r = await fetch(`${base}/vendor/three.module.js`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /javascript/);
    const text = await r.text();
    assert.ok(text.length > 100_000, '应为完整 three.js 模块');
  });

  it('错误口径：未知字段被拒绝、未知路由 404', async () => {
    const bad = await post('section', { profileSpec: { width: 20, height: 20, typo: 1 } });
    assert.equal(bad.json.ok, false);
    assert.match(String(bad.json.message), /未知字段/);

    const r = await fetch(`${base}/api/nope`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 404);
  });
});
