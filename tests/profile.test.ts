import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sectionProperties } from '../src/geom/inertia.ts';
import { GeometryInputError, v2 } from '../src/geom/polygon.ts';
import type { ProfileSpec, SlotSpec } from '../src/geom/profile.ts';
import {
  ALL_FACES,
  buildProfile,
  circlePolygon,
  parseProfileSpec,
  regularPolygonProperties,
} from '../src/geom/profile.ts';
import { TOL } from '../src/geom/tolerance.ts';

const SLOT: SlotSpec = { opening: 6, depth: 5.5, headWidth: 8, headStart: 2 };
const BASE: ProfileSpec = { width: 20, height: 20, slot: SLOT, bore: { radius: 2.25, segments: 8 } };

function assertClose(actual: number, expected: number, label: string, rel: number = TOL.relVerify): void {
  const scale = Math.max(Math.abs(expected), 1e-12);
  const error = Math.abs(actual - expected) / scale;
  assert.ok(error <= rel, `${label}: 期望 ${expected}，实测 ${actual}，相对误差 ${error.toExponential(2)}`);
}

/** 期望值为 0 时用绝对容差，避免「相对误差」把 1e-19 放大成 1e-6。 */
function assertCloseAbs(actual: number, expected: number, label: string, abs: number = 1e-12): void {
  assert.ok(Math.abs(actual - expected) <= abs, `${label}: 期望 ${expected}，实测 ${actual}，绝对误差 ${Math.abs(actual - expected)}`);
}

const rectArea = (b: number, h: number): number => b * h;
const rectIx = (b: number, h: number, cy: number): number => (b * h ** 3) / 12 + b * h * cy * cy;

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof GeometryInputError ? error.reason : `NOT_GEOMETRY_ERROR:${String(error)}`;
  }
}

describe('参数化截面：与独立手算分解对账', () => {
  it('四槽 + 八边形孔的 20×20 截面', () => {
    const geometry = buildProfile(BASE);
    const actual = sectionProperties(geometry.outer, geometry.holes);

    const squareArea = 400;
    const squareIx = (20 * 20 ** 3) / 12;

    // 上下槽（沿 y 方向挖）：开口 6×2 于 y=±9，T 头 8×3.5 于 y=±6.25。
    const verticalSlotArea = rectArea(6, 2) + rectArea(8, 3.5);
    const verticalSlotIx = rectIx(6, 2, -9) + rectIx(8, 3.5, -6.25) + rectIx(6, 2, 9) + rectIx(8, 3.5, 6.25);
    // 左右槽（沿 x 方向挖）：开口 2×6、T 头 3.5×8，形心落在 x 轴。
    const horizontalSlotArea = rectArea(2, 6) + rectArea(3.5, 8);
    const horizontalSlotIx = 2 * (rectIx(2, 6, 0) + rectIx(3.5, 8, 0));

    const bore = regularPolygonProperties(2.25, 8);
    const expectedArea = squareArea - 2 * verticalSlotArea - 2 * horizontalSlotArea - bore.area;
    const expectedIx = squareIx - verticalSlotIx - horizontalSlotIx - bore.ix;

    assertClose(actual.area, expectedArea, 'A');
    assertClose(actual.ix, expectedIx, 'Ix');
    assertClose(actual.iy, expectedIx, 'Iy（四重对称）');
    assert.ok(Math.abs(actual.ixy) < 1e-9, `Ixy 应为 0，实测 ${actual.ixy}`);
    assert.ok(Math.abs(actual.principal.imax - actual.principal.imin) < 1e-9, 'imax 与 imin 应相等');
    assertCloseAbs(actual.centroid.x, 0, 'cx');
    assertCloseAbs(actual.centroid.y, 0, 'cy');
  });

  it('仅底面开槽：形心上移，Ix 按平行轴定理复核', () => {
    const geometry = buildProfile({ ...BASE, slotFaces: ['bottom'] });
    const actual = sectionProperties(geometry.outer, geometry.holes);

    const squareArea = 400;
    const slotArea = rectArea(6, 2) + rectArea(8, 3.5);
    // 开口形心 y=−9，T 头形心 y=−6.25。
    const slotCy = (rectArea(6, 2) * -9 + rectArea(8, 3.5) * -6.25) / slotArea;
    const slotIxOrigin = rectIx(6, 2, -9) + rectIx(8, 3.5, -6.25);
    const bore = regularPolygonProperties(2.25, 8);

    const expectedArea = squareArea - slotArea - bore.area;
    const expectedCy = (0 - slotArea * slotCy) / expectedArea;
    const ixOrigin = (20 * 20 ** 3) / 12 - slotIxOrigin - bore.ix;
    const expectedIx = ixOrigin - expectedArea * expectedCy * expectedCy;

    assertClose(actual.area, expectedArea, 'A');
    assertClose(actual.centroid.y, expectedCy, 'cy');
    assert.ok(Math.abs(actual.ixy) < 1e-9, '仅底面开槽仍关于 y 轴对称，Ixy 应为 0');
    assertClose(actual.ix, expectedIx, 'Ix');
    assert.ok(actual.ix < actual.iy, '底面开槽后 Ix 应小于 Iy');
  });

  it('矩形截面支持非正方形宽高', () => {
    const geometry = buildProfile({ width: 20, height: 40, slot: SLOT, bore: { radius: 3, segments: 16 } });
    const actual = sectionProperties(geometry.outer, geometry.holes);
    assert.ok(actual.area > 0);
    assert.ok(actual.ix > actual.iy, '高大于宽时 Ix 应更大');
    assert.ok(Math.abs(actual.ixy) < 1e-9);
  });
});

describe('参数化截面：输入校验', () => {
  it('未知字段直接拒绝', () => {
    assert.equal(reasonOf(() => parseProfileSpec({ width: 20, height: 20, dims: {} })), 'degenerate');
    assert.throws(() => parseProfileSpec({ width: 20, height: 20, dims: {} }), /未知字段/);
  });

  it('缺少尺寸或类型错误被拒绝', () => {
    assert.throws(() => parseProfileSpec({ height: 20 }), /width/);
    assert.throws(() => parseProfileSpec({ width: '20', height: 20 }), /width/);
    assert.throws(() => parseProfileSpec({ width: 20, height: 20, slotFaces: ['up'] }), /slotFaces/);
    assert.throws(() => parseProfileSpec({ width: 20, height: 20, slotFaces: 'top' }), /slotFaces/);
  });

  it('T 槽尺寸自相矛盾时被拒绝', () => {
    assert.throws(
      () => buildProfile({ ...BASE, slot: { ...SLOT, headWidth: 6 } }),
      /headWidth.*必须大于 opening/,
    );
    assert.throws(
      () => buildProfile({ ...BASE, slot: { ...SLOT, headStart: 5.5 } }),
      /headStart.*必须小于 depth/,
    );
  });

  it('槽在角部相交时被拒绝', () => {
    assert.throws(() => buildProfile({ ...BASE, slot: { ...SLOT, headWidth: 14 } }), /角部相交/);
  });

  it('中心孔与槽冲突时被拒绝', () => {
    assert.throws(() => buildProfile({ ...BASE, bore: { radius: 4.5, segments: 16 } }), /冲突/);
  });

  it('孔边数超范围被拒绝', () => {
    assert.throws(() => buildProfile({ ...BASE, bore: { radius: 2.25, segments: 4 } }), /边数/);
    assert.throws(() => buildProfile({ ...BASE, bore: { radius: 2.25, segments: 513 } }), /边数/);
  });

  it('只给 slotFaces 不给 slot 尺寸被拒绝', () => {
    assert.throws(() => buildProfile({ width: 20, height: 20, slotFaces: ['top'] }), /slotFaces/);
  });

  it('非正尺寸被拒绝', () => {
    assert.throws(() => buildProfile({ width: 0, height: 20 }), /width/);
    assert.throws(() => buildProfile({ width: 20, height: -1 }), /height/);
  });
});

describe('中心孔离散', () => {
  it('弦高容差反算边数：r=2.25、sagitta=0.01 得到 34 边形', () => {
    const geometry = buildProfile({ ...BASE, bore: { radius: 2.25, sagitta: 0.01 } });
    assert.equal(geometry.meta.boreSegments, 34);
  });

  it('边数越多，面积越接近 πr²', () => {
    const radius = 2.25;
    const exact = Math.PI * radius * radius;
    const area8 = regularPolygonProperties(radius, 8).area;
    const area64 = regularPolygonProperties(radius, 64).area;
    assert.ok(area8 < exact && area64 < exact);
    assert.ok(area64 > area8);
    assert.ok((exact - area64) / exact < 2e-3);
    assert.ok((exact - area8) / exact > 1e-2);
  });

  it('circlePolygon 的积分结果与闭式解一致', () => {
    const radius = 2.25;
    const segments = 64;
    const points = circlePolygon(radius, segments);
    const actual = sectionProperties(points);
    const expected = regularPolygonProperties(radius, segments);
    assertClose(actual.area, expected.area, 'A');
    assertClose(actual.ix, expected.ix, 'Ix');
    assertClose(actual.iy, expected.iy, 'Iy');
    assert.ok(Math.abs(actual.ixy) < 1e-9);
  });

  it('圆的内接多边形略小于外接圆面积，且形心在原点', () => {
    const actual = sectionProperties(circlePolygon(2.25, 34));
    assertCloseAbs(actual.centroid.x, 0, 'cx');
    assertCloseAbs(actual.centroid.y, 0, 'cy');
    assert.ok(actual.area < Math.PI * 2.25 ** 2);
  });
});

describe('生成的轮廓本身合法', () => {
  it('四个面开槽 + 孔的轮廓无自交，能被统一入口接受', () => {
    const geometry = buildProfile(BASE);
    assert.equal(geometry.outer.length, 36); // 4 角点 + 4×8 槽点
    assert.equal(geometry.holes.length, 1);
    assert.ok(geometry.meta.boreArea > 0);
    assert.deepEqual([...geometry.meta.slotFaces], [...ALL_FACES]);
    const props = sectionProperties(geometry.outer, geometry.holes);
    assert.equal(props.isValid, true);
  });

  it('无槽无孔时退化为实心矩形', () => {
    const geometry = buildProfile({ width: 20, height: 10 });
    assert.equal(geometry.holes.length, 0);
    const props = sectionProperties(geometry.outer);
    assertClose(props.area, 200, 'A');
    assertClose(props.ix, (20 * 10 ** 3) / 12, 'Ix');
  });

  it('点对象形式的顶点与坐标数值一致（防止 v2 单位包装丢精度）', () => {
    const geometry = buildProfile(BASE);
    for (const p of geometry.outer) {
      assert.equal(typeof p.x, 'number');
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    }
    assert.ok(v2(1, 2).x === 1 && v2(1, 2).y === 2);
  });
});
