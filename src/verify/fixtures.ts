import type { SectionProperties } from '../geom/inertia.ts';
import { v2 } from '../geom/polygon.ts';
import type { Vec2 } from '../geom/polygon.ts';
import { centeredRectContour, normalizeContour } from '../geom/polygon.ts';
import { buildProfile } from '../geom/profile.ts';
import { TOL } from '../geom/tolerance.ts';

/**
 * 手算对照算例库。
 * 这一份数据同时被三处使用：单元测试、`mycad bench` 自检、文档里的验收依据。
 * 每个算例的 derivation 必须能让人不看代码就复核。
 */

export interface CaseExpectation {
  readonly area: number;
  readonly cx: number;
  readonly cy: number;
  readonly ix: number;
  readonly iy: number;
  readonly ixy: number;
  readonly wxTop?: number;
  readonly wxBottom?: number;
  readonly wyRight?: number;
  readonly wyLeft?: number;
}

export interface VerifyCase {
  readonly id: string;
  readonly title: string;
  readonly outer: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  readonly expect: CaseExpectation;
  readonly derivation: readonly string[];
  /** 对称性：both=上下左右都对称，y=仅关于 y 轴（左右）对称，none=无对称。 */
  readonly symmetry: SymmetryAxis;
}

export type SymmetryAxis = 'both' | 'y' | 'none';

const rect = centeredRectContour;
const pts = (r: { points: readonly Vec2[] }): readonly Vec2[] => r.points;

/**
 * 合成 2020 理想截面：尺寸全部由本项目定义，不对应任何厂商型号或标准。
 * 四槽 + 八边形中心孔的直角模型，用于验证参数化 DSL 与手算分解一致。
 */
export const SYN_2020_SPEC = {
  width: 20,
  height: 20,
  slot: { opening: 6, depth: 5.5, headWidth: 8, headStart: 2 },
  bore: { radius: 2.25, segments: 8 },
} as const;

const SYN_2020 = buildProfile(SYN_2020_SPEC);

export const VERIFY_CASES: readonly VerifyCase[] = [
  {
    id: 'rect-40x20',
    title: '实心矩形 40×20（b 沿 x，h 沿 y）',
    outer: pts(rect(40, 20)),
    holes: [],
    symmetry: 'both',
    expect: {
      area: 800,
      cx: 0,
      cy: 0,
      ix: 26666.666666666668,
      iy: 106666.66666666667,
      ixy: 0,
      wxTop: 2666.666666666667,
      wxBottom: 2666.666666666667,
      wyLeft: 5333.333333333334,
      wyRight: 5333.333333333334,
    },
    derivation: [
      'A = b·h = 40·20 = 800',
      'Ix = b·h³/12 = 40·8000/12 = 26666.6667',
      'Iy = h·b³/12 = 20·64000/12 = 106666.6667',
      'Wx = Ix/(h/2) = 26666.6667/10 = 2666.6667',
      'Wy = Iy/(b/2) = 106666.6667/20 = 5333.3333',
      '对称截面：形心 (0,0)，Ixy = 0',
    ],
  },
  {
    id: 'tube-40x20-t3',
    title: '方管 40×20，壁厚 3',
    outer: pts(rect(40, 20)),
    holes: [pts(rect(34, 14))],
    symmetry: 'both',
    expect: {
      area: 324,
      cx: 0,
      cy: 0,
      ix: 18892,
      iy: 60812,
      ixy: 0,
      wxTop: 1889.2,
      wxBottom: 1889.2,
      wyLeft: 3040.6,
      wyRight: 3040.6,
    },
    derivation: [
      'A = 40·20 − 34·14 = 800 − 476 = 324',
      'Ix = (40·20³ − 34·14³)/12 = (320000 − 93296)/12 = 18892',
      'Iy = (20·40³ − 14·34³)/12 = (1280000 − 550256)/12 = 60812',
      'Wx = 18892/10 = 1889.2，Wy = 60812/20 = 3040.6',
      '验证孔洞扣除：靠绕向归一化为负面积自动完成',
    ],
  },
  {
    id: 'tsection-40x50',
    title: 'T 形截面：翼缘 40×10 在上，腹板 10×40 在下',
    outer: [
      v2(-20, 40),
      v2(-5, 40),
      v2(-5, 0),
      v2(5, 0),
      v2(5, 40),
      v2(20, 40),
      v2(20, 50),
      v2(-20, 50),
    ],
    holes: [],
    symmetry: 'y',
    expect: {
      area: 800,
      cx: 0,
      cy: 32.5,
      ix: 181666.66666666666,
      iy: 56666.666666666664,
      ixy: 0,
      wxTop: 10380.952380952382,
      wxBottom: 5589.74358974359,
      wyLeft: 2833.333333333333,
      wyRight: 2833.333333333333,
    },
    derivation: [
      'A = 40·10 + 10·40 = 400 + 400 = 800',
      '形心高 cy = (400·45 + 400·20)/800 = 32.5（底边为 y=0）',
      'Ix = [10³·40/12 + 400·12.5²] + [40³·10/12 + 400·12.5²] = 65833.33 + 115833.33 = 181666.67',
      'Iy = 10·40³/12 + 40·10³/12 = 53333.33 + 3333.33 = 56666.67',
      'Wx_top = 181666.67/(50−32.5) = 10380.95，Wx_bottom = 181666.67/32.5 = 5589.74',
      '验证非对称截面的上下边缘模量不相等',
    ],
  },
  {
    id: 'hole-offcenter',
    title: '40×20 带偏心方孔 8×8（孔心 (5,4)）',
    outer: pts(rect(40, 20)),
    // 孔必须严格位于外轮廓内部；贴着边界就不是孔，而是外轮廓上的缺口。
    holes: [normalizeContour({ role: 'hole', points: [v2(1, 0), v2(9, 0), v2(9, 8), v2(1, 8)] }).points],
    symmetry: 'none',
    expect: {
      area: 736,
      cx: -10 / 23,
      cy: -8 / 23,
      ix: 25212.289855072463,
      iy: 104586.20289855072,
      ixy: -1391.304347826087,
    },
    derivation: [
      'A = 800 − 8·8 = 736',
      'cx = (800·0 − 64·5)/736 = −10/23 = −0.43478261',
      'cy = (800·0 − 64·4)/736 = −8/23 = −0.34782609',
      'Ix_origin = 26666.67 − (8·8³/12 + 64·4²) = 26666.67 − 1365.33 = 25301.33',
      'Ix_c = 25301.33 − 736·(8/23)² = 25301.33 − 89.04 = 25212.29',
      'Iy_origin = 106666.67 − (8⁴/12 + 64·5²) = 106666.67 − 1941.33 = 104725.33',
      'Iy_c = 104725.33 − 736·(10/23)² = 104725.33 − 139.13 = 104586.20',
      'Ixy_origin = 0 − 64·5·4 = −1280',
      'Ixy_c = −1280 − 736·(−10/23)·(−8/23) = −1391.30',
      '本例专门验证惯性积与偏心孔：主轴不再与 x/y 平行',
    ],
  },
  {
    id: 'syn-2020-ideal',
    title: '合成 2020 理想截面（20×20，四槽，八边形中心孔）',
    outer: SYN_2020.outer,
    holes: SYN_2020.holes,
    symmetry: 'both',
    expect: {
      area: 225.6810876809724,
      cx: 0,
      cy: 0,
      ix: 8749.64693335582,
      iy: 8749.64693335582,
      ixy: 0,
      wxTop: 874.964693335582,
      wxBottom: 874.964693335582,
      wyLeft: 874.964693335582,
      wyRight: 874.964693335582,
    },
    derivation: [
      'A = 20² − 4·(6·2 + 8·3.5) − 14.3189 = 400 − 160 − 14.3189 = 225.6811',
      '单个槽 = 开口段 6×2 + T 头段 8×3.5 = 12 + 28 = 40 mm²',
      '上下槽：开口形心 y=±9，T 头形心 y=±6.25；Ix = 4 + 12·9² + 28.5833 + 28·6.25² = 2098.3333',
      '左右槽：开口 2×6、T 头 3.5×8，形心在 x 轴；Ix = 36 + 149.3333 = 185.3333',
      'Ix = 20·20³/12 − 2·2098.3333 − 2·185.3333 − 16.3531 = 13333.3333 − 4567.3333 − 16.3531 = 8749.6469',
      '中心孔为正八边形（r=2.25）：A = 14.3189，Ix = 16.3531',
      '四重对称 ⇒ Ix=Iy、Ixy=0、imax=imin；本例验证参数化 DSL 与手算分解一致',
    ],
  },
] as const;

/** 单项偏差：实测值与手算值的相对误差，用于测试与 `mycad bench` 共用同一判定口径。 */
export interface Deviation {
  readonly field: keyof CaseExpectation;
  readonly expected: number;
  readonly actual: number;
  readonly relError: number;
}

/** 对照结果。deviations 只收录超出容差的项，maxRelError 收录全部项里的最大相对误差。 */
export interface Comparison {
  readonly deviations: readonly Deviation[];
  readonly maxRelError: number;
  readonly ok: boolean;
}

/**
 * 把实测截面特性与算例逐项比较，只比较算例声明过的字段（W 只在需要时列入）。
 * 返回空 deviations 即通过；判定口径取 TOL.relVerify，与测试、bench 完全一致。
 */
export function compareToExpectation(
  actual: SectionProperties,
  expect: CaseExpectation,
  relTol: number = TOL.relVerify,
): Comparison {
  const pairs: readonly (readonly [keyof CaseExpectation, number])[] = [
    ['area', actual.area],
    ['cx', actual.centroid.x],
    ['cy', actual.centroid.y],
    ['ix', actual.ix],
    ['iy', actual.iy],
    ['ixy', actual.ixy],
    ['wxTop', actual.modulus.wxTop],
    ['wxBottom', actual.modulus.wxBottom],
    ['wyLeft', actual.modulus.wyLeft],
    ['wyRight', actual.modulus.wyRight],
  ];

  const deviations: Deviation[] = [];
  let maxRelError = 0;
  for (const [field, got] of pairs) {
    const want = expect[field];
    if (want === undefined) continue;
    // 期望值为 0 时相对误差没有意义，退化为绝对误差（此时结构对称，量级本身就接近 0）。
    const rel = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
    if (Number.isFinite(rel) && rel > maxRelError) maxRelError = rel;
    if (!(rel <= relTol)) deviations.push({ field, expected: want, actual: got, relError: rel });
  }
  return { deviations, maxRelError, ok: deviations.length === 0 };
}

/** 对称截面需要的四个截面模量，CaseExpectation 与 SectionProperties['modulus'] 都满足。 */
export interface SymmetricModulus {
  readonly wxTop?: number;
  readonly wxBottom?: number;
  readonly wyLeft?: number;
  readonly wyRight?: number;
}

/**
 * 对称性断言辅助：按算例声明的对称方向检查截面模量。
 * both 要求上下、左右都相等；y 只要求左右相等（T 形等上下不等的截面）。
 * 返回不成立的说明，空数组即通过。用于防止 W 的取边逻辑在某些绕向下悄悄取错。
 */
export function symmetryProblems(
  modulus: SymmetricModulus,
  axis: SymmetryAxis = 'both',
  relTol: number = TOL.relVerify,
): string[] {
  const out: string[] = [];
  const check = (a: number | undefined, b: number | undefined, label: string): void => {
    if (a === undefined || b === undefined) return;
    const scale = Math.max(Math.abs(a), Math.abs(b), 1);
    if (Math.abs(a - b) > relTol * scale) out.push(`${label} 不对称：${a} ≠ ${b}`);
  };
  if (axis === 'both') check(modulus.wxTop, modulus.wxBottom, 'Wx 上下');
  if (axis === 'both' || axis === 'y') check(modulus.wyLeft, modulus.wyRight, 'Wy 左右');
  return out;
}
