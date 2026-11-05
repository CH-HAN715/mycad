import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SectionProperties } from '../src/geom/inertia.ts';
import { sectionProperties, sig } from '../src/geom/inertia.ts';
import type { Vec2 } from '../src/geom/polygon.ts';
import {
  GeometryInputError,
  MAX_CONTOUR_VERTICES,
  centeredRectContour,
  normalizeContour,
  rectContour,
  signedArea,
  v2,
} from '../src/geom/polygon.ts';
import { TOL } from '../src/geom/tolerance.ts';
import { VERIFY_CASES, compareToExpectation, symmetryProblems } from '../src/verify/fixtures.ts';

function assertClose(actual: number, expected: number, label: string, rel: number = TOL.relVerify): void {
  const scale = Math.max(Math.abs(expected), 1e-12);
  const error = Math.abs(actual - expected) / scale;
  assert.ok(error <= rel, `${label}: 期望 ${expected}，实测 ${actual}，相对误差 ${error.toExponential(2)}`);
}

function assertCloseAbs(actual: number, expected: number, label: string, abs: number = TOL.relVerify): void {
  assert.ok(Math.abs(actual - expected) <= abs, `${label}: 期望 ${expected}，实测 ${actual}，绝对误差 ${Math.abs(actual - expected)}`);
}

/** 角度差归一到 (-90, 90]，主轴只有方向没有正负。 */
function angleDiff(a: number, b: number): number {
  let d = (a - b) % 180;
  if (d <= -90) d += 180;
  if (d > 90) d -= 180;
  return d;
}

/** I(θ) = (Ix+Iy)/2 + (Ix−Iy)/2·cos2θ − Ixy·sin2θ */
function secondMomentAt(s: SectionProperties, thetaDeg: number): number {
  const t = (thetaDeg * Math.PI) / 180;
  return (s.ix + s.iy) / 2 + ((s.ix - s.iy) / 2) * Math.cos(2 * t) - s.ixy * Math.sin(2 * t);
}

function rotate(points: readonly Vec2[], deg: number): Vec2[] {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return points.map((p) => v2(p.x * c - p.y * s, p.x * s + p.y * c));
}

function translate(points: readonly Vec2[], dx: number, dy: number): Vec2[] {
  return points.map((p) => v2(p.x + dx, p.y + dy));
}

describe('手算对照算例库', () => {
  for (const testCase of VERIFY_CASES) {
    it(testCase.id, () => {
      const actual = sectionProperties(testCase.outer, testCase.holes);
      const comparison = compareToExpectation(actual, testCase.expect);
      assert.equal(
        comparison.ok,
        true,
        `${testCase.id} 偏差：${comparison.deviations
          .map((d) => `${d.field} 期望 ${d.expected} 实测 ${d.actual}`)
          .join('；')}`,
      );

      if (testCase.symmetry !== 'none') {
        assert.deepEqual(symmetryProblems(testCase.expect, testCase.symmetry), [], '算例声明的对称性不成立');
        assert.deepEqual(symmetryProblems(actual.modulus, testCase.symmetry), [], '实测截面模量不满足对称性');
      }
    });
  }

  it('T 形：左右模量相等，上下模量必须不等', () => {
    const tSection = VERIFY_CASES.find((c) => c.id === 'tsection-40x50');
    assert.ok(tSection !== undefined);
    const s = sectionProperties(tSection.outer, tSection.holes);
    assertClose(s.modulus.wyLeft, s.modulus.wyRight, 'Wy 左右');
    assert.ok(
      Math.abs(s.modulus.wxTop - s.modulus.wxBottom) > 1,
      `T 形上下模量不应相等：${s.modulus.wxTop} vs ${s.modulus.wxBottom}`,
    );
    assert.ok(s.modulus.wxTop > s.modulus.wxBottom, '翼缘在上时 Wx_top 应大于 Wx_bottom');
  });
});

describe('矩形解析解', () => {
  for (const [b, h] of [[40, 20], [3, 7], [100, 2.5]] as const) {
    it(`${b}×${h}`, () => {
      const s = sectionProperties(centeredRectContour(b, h).points);
      assertClose(s.area, b * h, 'A');
      assertClose(s.ix, (b * h ** 3) / 12, 'Ix');
      assertClose(s.iy, (h * b ** 3) / 12, 'Iy');
      assertCloseAbs(s.centroid.x, 0, 'cx');
      assertCloseAbs(s.centroid.y, 0, 'cy');
      assertCloseAbs(s.ixy, 0, 'Ixy');
      assertClose(s.modulus.wxTop, s.ix / (h / 2), 'Wx');
      assertClose(s.modulus.wyRight, s.iy / (b / 2), 'Wy');
      assertCloseAbs(s.extremes.yTop + s.extremes.yBottom, h, '上下最外纤维距离之和');
      assertClose(s.principal.imax, Math.max(s.ix, s.iy), 'imax');
      assertClose(s.principal.imin, Math.min(s.ix, s.iy), 'imin');
      // 矩形的主轴就是较长边方向：Ix > Iy 时 imax 沿 +x（θ=0），否则沿 +y（θ=90）。
      const expectedTheta = s.ix >= s.iy ? 0 : 90;
      assertCloseAbs(angleDiff(s.principal.thetaDeg, expectedTheta), 0, '主轴角', 1e-9);
    });
  }
});

describe('不变量', () => {
  const base = sectionProperties(centeredRectContour(40, 20).points);

  it('旋转 30° 后 A、Ix+Iy、主轴、回转半径不变，主轴角同步转动', () => {
    const rotated = sectionProperties(rotate(centeredRectContour(40, 20).points, 30));
    assertClose(rotated.area, base.area, 'A');
    assertClose(rotated.ix + rotated.iy, base.ix + base.iy, 'Ix+Iy');
    assertClose(rotated.principal.imax, base.principal.imax, 'imax');
    assertClose(rotated.principal.imin, base.principal.imin, 'imin');
    assertClose(rotated.principal.radiusMax, base.principal.radiusMax, 'radiusMax');
    assertClose(rotated.principal.radiusMin, base.principal.radiusMin, 'radiusMin');
    assert.ok(Math.abs(angleDiff(rotated.principal.thetaDeg, base.principal.thetaDeg + 30)) <= 1e-9, '主轴角随截面旋转 30°');
    assert.ok(Math.abs(rotated.ixy) > 1, '旋转后惯性积不应为 0');
  });

  it('平移 (13, −7) 后形心同步平移，形心轴惯性矩与 W 不变', () => {
    const moved = sectionProperties(translate(centeredRectContour(40, 20).points, 13, -7));
    assertClose(moved.centroid.x, 13, 'cx');
    assertClose(moved.centroid.y, -7, 'cy');
    assertClose(moved.ix, base.ix, 'Ix');
    assertClose(moved.iy, base.iy, 'Iy');
    assertCloseAbs(moved.ixy, 0, 'Ixy');
    assertClose(moved.modulus.wxTop, base.modulus.wxTop, 'Wx');
    assertClose(moved.modulus.wyRight, base.modulus.wyRight, 'Wy');
  });

  it('旋转 + 平移同时作用时面积、主轴与孔洞扣除仍成立', () => {
    const transform = (points: readonly Vec2[]): Vec2[] => translate(rotate(points, -17), 3, 2);
    const s = sectionProperties(transform(centeredRectContour(40, 20).points), [
      transform(centeredRectContour(10, 10).points),
    ]);
    const baseTube = sectionProperties(centeredRectContour(40, 20).points, [centeredRectContour(10, 10).points]);
    assertClose(s.area, 800 - 100, 'A');
    assertClose(s.principal.imax, baseTube.principal.imax, '刚体变换不改变 imax');
    assertClose(s.principal.imin, baseTube.principal.imin, '刚体变换不改变 imin');
    // 注意：W = I / 到包围盒最外纤维的距离，随坐标轴方向变化，旋转后不守恒；只在平移下不变。
  });
});

describe('主轴角取极大值', () => {
  for (const testCase of VERIFY_CASES) {
    it(`${testCase.id} 的 thetaDeg 确为 I(θ) 极大点`, () => {
      const s = sectionProperties(testCase.outer, testCase.holes);
      const atTheta = secondMomentAt(s, s.principal.thetaDeg);
      assertClose(atTheta, s.principal.imax, 'I(theta) = imax');
      assertClose(secondMomentAt(s, s.principal.thetaDeg + 90), s.principal.imin, 'I(theta+90) = imin');
      // 在 ±0.5° 邻域内取 21 个采样点，thetaDeg 必须是最大值。
      for (let d = -0.5; d <= 0.5; d += 0.05) {
        assert.ok(secondMomentAt(s, s.principal.thetaDeg + d) <= s.principal.imax + 1e-9, `theta+${d.toFixed(2)}° 超过了 imax`);
      }
    });
  }
});

describe('轮廓归一与输入校验', () => {
  it('外轮廓反向输入会被归一为 CCW，结果不变', () => {
    const ccw = rectContour(40, 20).points;
    const cw = [...ccw].reverse();
    assert.ok(signedArea(cw) < 0);
    const s = sectionProperties(cw);
    assertClose(s.area, 800, 'A');
    assertClose(s.ix, 26666.666666666668, 'Ix');
  });

  it('孔洞绕向错误（CCW 输入）依然按负面积扣除', () => {
    const outer = centeredRectContour(40, 20).points;
    const holeCcw = centeredRectContour(34, 14).points;
    const holeCw = normalizeContour({ role: 'hole', points: holeCcw }).points;
    const a = sectionProperties(outer, [holeCcw]);
    const b = sectionProperties(outer, [holeCw]);
    assertClose(a.area, 324, '孔洞 CCW 输入');
    assertClose(b.area, 324, '孔洞 CW 输入');
    assertClose(a.ix, b.ix, '两种绕向 Ix 一致');
  });

  it('重复的闭合首点会被去掉', () => {
    const p = [v2(0, 0), v2(40, 0), v2(40, 20), v2(0, 20), v2(0, 0)];
    const s = sectionProperties(p);
    assertClose(s.area, 800, 'A');
  });

  it('顶点不足 3 个时抛出可读错误', () => {
    assert.throws(
      () => sectionProperties([v2(0, 0), v2(10, 0)]),
      (error: unknown) => error instanceof GeometryInputError && error.code === 'E_INPUT_GEOMETRY' && error.hint.length > 0,
    );
  });

  it('共线或自交（面积 0）的轮廓被拒绝', () => {
    assert.throws(() => sectionProperties([v2(0, 0), v2(1, 0), v2(2, 0)]), GeometryInputError);
    // 蝴蝶结自交：鞋带面积正好抵消为 0。
    assert.throws(() => sectionProperties([v2(0, 0), v2(10, 10), v2(10, 0), v2(0, 10)]), GeometryInputError);
  });

  it('孔洞大于外轮廓时被拓扑校验拒绝', () => {
    assert.throws(
      () => sectionProperties(centeredRectContour(10, 10).points, [centeredRectContour(20, 20).points]),
      (error: unknown) => error instanceof GeometryInputError && error.reason === 'hole_outside',
    );
  });
});

describe('非法几何必须被拒绝（不允许静默算错）', () => {
  const reasonOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (error) {
      return error instanceof GeometryInputError ? error.reason : 'NOT_GEOMETRY_ERROR';
    }
  };

  it('五角星自交轮廓被拒绝', () => {
    const star: Vec2[] = [];
    for (let i = 0; i < 5; i++) {
      const angle = ((i * 144 - 90) * Math.PI) / 180;
      star.push(v2(20 * Math.cos(angle), 20 * Math.sin(angle)));
    }
    assert.equal(reasonOf(() => sectionProperties(star)), 'self_intersection');
  });

  it('非相邻边相交（蝴蝶结）被拒绝', () => {
    assert.equal(
      reasonOf(() => sectionProperties([v2(0, 0), v2(10, 10), v2(10, 0), v2(0, 10)])),
      'self_intersection',
    );
  });

  it('共线折返的零面积尖刺被拒绝', () => {
    assert.equal(
      reasonOf(() => sectionProperties([v2(0, 0), v2(10, 0), v2(5, 0), v2(5, 10)])),
      'self_intersection',
    );
  });

  it('孔洞完全位于外轮廓之外被拒绝', () => {
    const outer = centeredRectContour(40, 20).points;
    const outside = translate(centeredRectContour(10, 10).points, 100, 100);
    assert.equal(reasonOf(() => sectionProperties(outer, [outside])), 'hole_outside');
  });

  it('孔洞贴外轮廓边界被拒绝', () => {
    const outer = centeredRectContour(40, 20).points;
    const touching = translate(centeredRectContour(10, 10).points, 0, 15);
    assert.equal(reasonOf(() => sectionProperties(outer, [touching])), 'hole_outside');
  });

  it('两孔重叠被拒绝（否则重复扣面积）', () => {
    const outer = centeredRectContour(40, 20).points;
    const a = translate(centeredRectContour(10, 10).points, -4, 0);
    const b = translate(centeredRectContour(10, 10).points, 4, 0);
    assert.equal(reasonOf(() => sectionProperties(outer, [a, b])), 'hole_overlap');
  });

  it('孔中孔（嵌套）被拒绝', () => {
    const outer = centeredRectContour(40, 20).points;
    const big = centeredRectContour(20, 14).points;
    const small = centeredRectContour(6, 6).points;
    assert.equal(reasonOf(() => sectionProperties(outer, [big, small])), 'hole_overlap');
  });

  it('孔洞与外轮廓完全重合被拒绝', () => {
    const outer = centeredRectContour(40, 20).points;
    assert.equal(reasonOf(() => sectionProperties(outer, [outer])), 'hole_outside');
  });

  it('顶点数超过上限被拒绝', () => {
    const points: Vec2[] = [];
    for (let i = 0; i < MAX_CONTOUR_VERTICES + 1; i++) {
      const angle = (2 * Math.PI * i) / (MAX_CONTOUR_VERTICES + 1);
      points.push(v2(10 * Math.cos(angle), 10 * Math.sin(angle)));
    }
    assert.equal(reasonOf(() => sectionProperties(points)), 'too_many_vertices');
  });
});

describe('数值稳健性', () => {
  const base = sectionProperties(centeredRectContour(40, 20).points);

  for (const distance of [1e3, 1e6, 1e9]) {
    it(`坐标平移到 ${distance.toExponential(0)} mm 后 Ix 相对误差 < 1e-12`, () => {
      const far = sectionProperties(translate(centeredRectContour(40, 20).points, distance, distance));
      assertClose(far.ix, base.ix, 'Ix', 1e-12);
      assertClose(far.iy, base.iy, 'Iy', 1e-12);
      assertClose(far.area, base.area, 'A', 1e-12);
      assertClose(far.centroid.x, distance, 'cx', 1e-12);
    });
  }

  it('缩放律：A∝k²、I∝k⁴、W∝k³', () => {
    const k = 3.7;
    const scaled = sectionProperties(centeredRectContour(40 * k, 20 * k).points);
    assertClose(scaled.area, base.area * k ** 2, 'A');
    assertClose(scaled.ix, base.ix * k ** 4, 'Ix');
    assertClose(scaled.iy, base.iy * k ** 4, 'Iy');
    assertClose(scaled.modulus.wxTop, base.modulus.wxTop * k ** 3, 'Wx');
    assertClose(scaled.principal.radiusMax, base.principal.radiusMax * k, '回转半径');
  });

  it('孔洞加性：I(外轮廓) = I(净截面) + I(孔)（同一形心轴）', () => {
    const outer = centeredRectContour(40, 20).points;
    const hole = translate(centeredRectContour(10, 10).points, 5, 3);
    const net = sectionProperties(outer, [hole]);
    const whole = sectionProperties(outer);
    const cut = sectionProperties(centeredRectContour(10, 10).points);

    // 把三份惯性矩都换算到净截面形心 C_n 的同一根轴上再相加。
    const dxOuter = 0 - net.centroid.x;
    const dyOuter = 0 - net.centroid.y;
    const dxHole = 5 - net.centroid.x;
    const dyHole = 3 - net.centroid.y;
    const areaOuter = 800;
    const areaHole = 100;

    assertClose(
      whole.ix + areaOuter * dyOuter * dyOuter,
      net.ix + cut.ix + areaHole * dyHole * dyHole,
      'Ix 加性',
    );
    assertClose(
      whole.iy + areaOuter * dxOuter * dxOuter,
      net.iy + cut.iy + areaHole * dxHole * dxHole,
      'Iy 加性',
    );
    assertClose(
      whole.ixy + areaOuter * dxOuter * dyOuter,
      net.ixy + cut.ixy + areaHole * dxHole * dyHole,
      'Ixy 加性',
    );
  });

  it('随机星形多边形：不抛错、不变量与刚体变换一致（200 例）', () => {
    const rand = mulberry32(20261105);
    for (let iteration = 0; iteration < 200; iteration++) {
      const points = randomStarPolygon(rand);
      const s = sectionProperties(points);

      assert.ok(s.area > 0, `第 ${iteration} 例面积非正`);
      assert.ok(s.principal.imax >= s.principal.imin, `第 ${iteration} 例 imax < imin`);
      assert.ok(s.principal.imin >= -1e-9, `第 ${iteration} 例 imin 为负`);
      assert.ok(s.centroid.x >= s.bbox.xMin && s.centroid.x <= s.bbox.xMax, `第 ${iteration} 例形心 x 越界`);
      assert.ok(s.centroid.y >= s.bbox.yMin && s.centroid.y <= s.bbox.yMax, `第 ${iteration} 例形心 y 越界`);
      for (const w of [s.modulus.wxTop, s.modulus.wxBottom, s.modulus.wyLeft, s.modulus.wyRight]) {
        assert.ok(Number.isFinite(w) && w > 0, `第 ${iteration} 例截面模量非法：${w}`);
      }

      const angle = 180 * (rand() - 0.5);
      const rotated = sectionProperties(rotate(points, angle));
      assertClose(rotated.area, s.area, `第 ${iteration} 例 A 旋转不变量`, 1e-9);
      assertClose(rotated.ix + rotated.iy, s.ix + s.iy, `第 ${iteration} 例 Ix+Iy 旋转不变量`, 1e-9);
      assertClose(rotated.principal.imax, s.principal.imax, `第 ${iteration} 例 imax 旋转不变量`, 1e-9);
      assertClose(rotated.principal.imin, s.principal.imin, `第 ${iteration} 例 imin 旋转不变量`, 1e-9);
    }
  });
});

/** 确定性 PRNG，保证 fuzz 失败可复现（mulberry32）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机星形多边形：极角在均匀分槽内抖动，最大间隔 < π，关于原点星形，必然简单、无自交。 */
function randomStarPolygon(rand: () => number): Vec2[] {
  const n = 5 + Math.floor(rand() * 20);
  const slot = (2 * Math.PI) / n;
  const angles: number[] = [];
  for (let i = 0; i < n; i++) angles.push(i * slot + (rand() - 0.5) * slot * 0.8);
  return angles.map((angle) => {
    const radius = 5 + rand() * 45;
    return v2(radius * Math.cos(angle), radius * Math.sin(angle));
  });
}

describe('输出层', () => {
  it('包入口导出与 geom 子入口一致', async () => {
    const root = await import('../src/index.ts');
    const geom = await import('../src/geom/index.ts');
    assert.equal(root.sectionProperties, geom.sectionProperties);
    assert.equal(root.TOL.coincide, TOL.coincide);
    assert.equal(typeof root.sectionProperties, 'function');
  });

  it('sig 只做有效数字清理，0 保持 0，非有限值原样返回', () => {
    assert.equal(sig(0), 0);
    assert.equal(sig(26666.666666666668), 26666.6666667);
    assert.ok(Number.isNaN(sig(Number.NaN)));
    assert.equal(sig(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  });
});
