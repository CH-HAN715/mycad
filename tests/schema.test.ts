import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { parseProfileSpec } from '../src/geom/profile.ts';
import { GeometryInputError } from '../src/geom/polygon.ts';
import { SCHEMA_VERSION } from '../src/geom/schema.ts';
import { parseRulesOverride, DEFAULT_CONNECT_RULES } from '../src/connect/rules.ts';
import { planCuts, CutInputError } from '../src/production/cutPlan.ts';
import { startServe } from '../src/serve/server.ts';
import type { ServeHandle } from '../src/serve/server.ts';

const SPEC = { width: 20, height: 20 };

describe('schema 版本字段', () => {
  it('型材规格接受当前版本，且不把它写进 ProfileSpec', () => {
    const spec = parseProfileSpec({ ...SPEC, schemaVersion: SCHEMA_VERSION });
    assert.equal(spec.width, 20);
    assert.equal('schemaVersion' in spec, false);
  });

  it('缺省不写版本号视为当前版本', () => {
    assert.equal(parseProfileSpec(SPEC).height, 20);
  });

  it('高于引擎支持的版本必须拒绝并给出可执行提示', () => {
    assert.throws(
      () => parseProfileSpec({ ...SPEC, schemaVersion: SCHEMA_VERSION + 1 }),
      (error: unknown) => {
        assert.ok(error instanceof GeometryInputError);
        assert.match((error as Error).message, /请升级引擎或改写文件/);
        return true;
      },
    );
  });

  it('版本号非整数拒绝', () => {
    assert.throws(() => parseProfileSpec({ ...SPEC, schemaVersion: '1' }), /必须是整数/);
  });

  it('规则覆盖同样接受并校验 schemaVersion', () => {
    const rules = parseRulesOverride({ schemaVersion: 1, bracketHolePitchMm: 25 });
    assert.equal(rules.bracketHolePitchMm, 25);
    assert.equal(rules.bracketHoleOffsetFromEndMm, DEFAULT_CONNECT_RULES.bracketHoleOffsetFromEndMm);
    assert.throws(() => parseRulesOverride({ schemaVersion: 99 }), /只支持 schemaVersion/);
  });

  it('规则覆盖的未知字段仍然直接拒绝', () => {
    assert.throws(() => parseRulesOverride({ bracketHolePitchM: 25 }), /未知字段/);
  });
});

describe('未知字段一律拒绝（补齐的入口）', () => {
  it('cut 的段定义带多余字段时拒绝', () => {
    assert.throws(
      () =>
        planCuts(
          [{ id: 'a', lengthMm: 600, quantity: 2, note: '多余的' } as never],
          { stockLengthMm: 6000, kerfMm: 3 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof CutInputError);
        assert.match((error as Error).message, /含未知字段：note/);
        return true;
      },
    );
  });

  it('合法段定义不受影响', () => {
    const plan = planCuts([{ id: 'a', lengthMm: 600, quantity: 2 }], { stockLengthMm: 6000, kerfMm: 3 });
    assert.equal(plan.totalPieces, 2);
  });
});

describe('serve 入口的字段口径', () => {
  let handle: ServeHandle;
  let base: string;

  before(async () => {
    handle = await startServe({ port: 0 });
    base = `http://127.0.0.1:${handle.port}`;
  });
  after(async () => {
    await handle.close();
  });

  async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${base}/api/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  }

  it('bom options 带未知字段被拒', async () => {
    const r = await post('bom', {
      frame: {
        profiles: [{ id: 'p', spec: SPEC }],
        members: [{ id: 'm', profileId: 'p', start: [0, 0, 0], end: [600, 0, 0] }],
      },
      options: { stockMm: 6000, kerfMm: 3, stock: 6000 },
    });
    assert.equal(r.json.ok, false);
    assert.match(String(r.json.message), /含未知字段：stock/);
  });

  it('cut options 带未知字段被拒', async () => {
    const r = await post('cut', {
      pieces: [{ id: 'a', lengthMm: 600, quantity: 2 }],
      options: { stockLengthMm: 6000, kerfMm: 3, stockLen: 6000 },
    });
    assert.equal(r.json.ok, false);
    assert.match(String(r.json.message), /含未知字段：stockLen/);
  });

  it('dxf-section 的 circles 带未知字段被拒', async () => {
    const r = await post('dxf-section', {
      profileSpec: SPEC,
      circles: [{ center: [10, 10], diameter: 5, depth: 20 }],
    });
    assert.equal(r.json.ok, false);
    assert.match(String(r.json.message), /含未知字段：depth/);
  });

  it('型材规格可带 schemaVersion 走 API', async () => {
    const r = await post('section', { profileSpec: { ...SPEC, schemaVersion: 1 } });
    assert.equal(r.json.ok, true);
  });
});
