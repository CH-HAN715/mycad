import type { Contour, Vec2 } from './polygon.ts';
import { MAX_CONTOUR_VERTICES, bboxOf, normalizeSection } from './polygon.ts';
import { TOL } from './tolerance.ts';
import type { Mm, Mm2, Mm3, Mm4, Ratio } from './units.ts';
import { U } from './units.ts';

/**
 * L2 截面特性：由有向多边形轮廓的惯性矩积分直接算出，不依赖任何供应商样本表。
 * 见 docs/工业级范围与里程碑.md 第 3 节。
 *
 * 对多边形而言这些积分是精确解（不是近似），因此测试验收口径取浮点舍入级相对误差。
 * 孔洞以 CW（负面积）绕向参与代数和，扣除自动成立。
 */

interface EdgeMoments {
  readonly area: number;
  readonly cx: number;
  readonly cy: number;
  readonly ixOrigin: number;
  readonly iyOrigin: number;
  readonly ixyOrigin: number;
}

function accumulate(points: readonly Vec2[], ox: number, oy: number): EdgeMoments {
  const n = points.length;
  let a2 = 0;
  let sx6 = 0;
  let sy6 = 0;
  let ix12 = 0;
  let iy12 = 0;
  let ixy24 = 0;

  for (let i = 0; i < n; i++) {
    const p0 = points[i]!;
    const p1 = points[(i + 1) % n]!;
    const x0 = p0.x - ox;
    const y0 = p0.y - oy;
    const x1 = p1.x - ox;
    const y1 = p1.y - oy;
    const cross = x0 * y1 - x1 * y0;

    a2 += cross;
    sx6 += (x0 + x1) * cross;
    sy6 += (y0 + y1) * cross;
    ix12 += cross * (y0 * y0 + y0 * y1 + y1 * y1);
    iy12 += cross * (x0 * x0 + x0 * x1 + x1 * x1);
    ixy24 += cross * (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0);
  }

  const area = a2 / 2;
  return {
    area,
    cx: sx6 / (6 * area),
    cy: sy6 / (6 * area),
    ixOrigin: ix12 / 12,
    iyOrigin: iy12 / 12,
    ixyOrigin: ixy24 / 24,
  };
}

export interface SectionProperties {
  readonly area: Mm2;
  readonly centroid: { readonly x: Mm; readonly y: Mm };
  /** 对形心轴（未旋转的 x/y 轴）的二次矩，量纲 mm^4。 */
  readonly ix: Mm4;
  readonly iy: Mm4;
  /** 对形心轴的惯性积 ∫xy dA，量纲 mm^4。对称截面应为 0。 */
  readonly ixy: Mm4;
  /** 形心主轴。thetaDeg 是 imax 主轴与 +x 轴的夹角，逆时针为正，归一到 (-90°, 90°]。 */
  readonly principal: {
    readonly imax: Mm4;
    readonly imin: Mm4;
    readonly thetaDeg: number;
    readonly radiusMax: Mm;
    readonly radiusMin: Mm;
  };
  /** 弹性截面模量 W = I / e，分边给出（非对称截面上下边缘不同），量纲 mm^3。 */
  readonly modulus: {
    readonly wxTop: Mm3;
    readonly wxBottom: Mm3;
    readonly wyLeft: Mm3;
    readonly wyRight: Mm3;
  };
  /** 相对形心的最外纤维距离，量纲 mm。 */
  readonly extremes: {
    readonly yTop: Mm;
    readonly yBottom: Mm;
    readonly xLeft: Mm;
    readonly xRight: Mm;
  };
  readonly bbox: { readonly xMin: Mm; readonly xMax: Mm; readonly yMin: Mm; readonly yMax: Mm };
  readonly isValid: boolean;
}

function principalAngleDeg(ix: number, iy: number, ixy: number): number {
  const half = (ix - iy) / 2;
  const twoTheta = Math.atan2(-ixy, half);
  let theta = twoTheta / 2;
  const avg = (ix + iy) / 2;
  const at = (t: number): number => avg + half * Math.cos(2 * t) - ixy * Math.sin(2 * t);
  // 自校验：theta 必须取到极大值，否则转 90°。避免绕向/符号约定在不同截面下悄悄出错。
  if (at(theta) < avg) theta += Math.PI / 2;
  let deg = (theta * 180) / Math.PI;
  while (deg <= -90) deg += 180;
  while (deg > 90) deg -= 180;
  if (Math.abs(deg) < TOL.principalZero) deg = 0;
  if (Math.abs(Math.abs(deg) - 90) < TOL.principalZero) deg = 90;
  return deg;
}

export function sectionProperties(
  outer: readonly Vec2[],
  holes: readonly (readonly Vec2[])[] = [],
): SectionProperties {
  // 统一入口：归一化 + 自交检测 + 孔洞拓扑校验，任何一层不合法都在这里拒绝。
  const section = normalizeSection(outer, holes);
  const contours: readonly Contour[] = [section.outer, ...section.holes];

  const allPoints: Vec2[] = contours.flatMap((c) => [...c.points]);
  const box = bboxOf(allPoints);

  // 先平移到包围盒中心再积分。远离原点时 x·y 量级可达 1e12 而结果只有 1e5，
  // 直接积分会产生灾难性抵消（1e6 mm 处 Ix 误差 2.4%）；平移后回到浮点舍入级。
  const ox = (box.xMin + box.xMax) / 2;
  const oy = (box.yMin + box.yMax) / 2;

  let area = 0;
  let sxa = 0;
  let sya = 0;
  let ixOrigin = 0;
  let iyOrigin = 0;
  let ixyOrigin = 0;

  for (const c of contours) {
    const m = accumulate(c.points, ox, oy);
    area += m.area;
    sxa += m.area * m.cx;
    sya += m.area * m.cy;
    ixOrigin += m.ixOrigin;
    iyOrigin += m.iyOrigin;
    ixyOrigin += m.ixyOrigin;
  }

  if (area <= TOL.minArea) {
    throw new RangeError(`截面净面积非正（${area} mm^2），轮廓定义有误`);
  }

  const cxLocal = sxa / area;
  const cyLocal = sya / area;
  const cx = ox + cxLocal;
  const cy = oy + cyLocal;

  const ix = ixOrigin - area * cyLocal * cyLocal;
  const iy = iyOrigin - area * cxLocal * cxLocal;
  const ixy = ixyOrigin - area * cxLocal * cyLocal;

  const avg = (ix + iy) / 2;
  const radius = Math.hypot((ix - iy) / 2, ixy);
  const imax = avg + radius;
  const imin = avg - radius;
  const thetaDeg = principalAngleDeg(ix, iy, ixy);

  const yTop = box.yMax - cy;
  const yBottom = cy - box.yMin;
  const xRight = box.xMax - cx;
  const xLeft = cx - box.xMin;

  return {
    area: U.mm2(area),
    centroid: { x: U.mm(cx), y: U.mm(cy) },
    ix: U.mm4(ix),
    iy: U.mm4(iy),
    ixy: U.mm4(ixy),
    principal: {
      imax: U.mm4(imax),
      imin: U.mm4(Math.max(imin, 0)),
      thetaDeg,
      radiusMax: U.mm(Math.sqrt(imax / area)),
      radiusMin: U.mm(Math.sqrt(Math.max(imin, 0) / area)),
    },
    modulus: {
      wxTop: U.mm3(ix / yTop),
      wxBottom: U.mm3(ix / yBottom),
      wyLeft: U.mm3(iy / xLeft),
      wyRight: U.mm3(iy / xRight),
    },
    extremes: {
      yTop: U.mm(yTop),
      yBottom: U.mm(yBottom),
      xLeft: U.mm(xLeft),
      xRight: U.mm(xRight),
    },
    bbox: { xMin: box.xMin, xMax: box.xMax, yMin: box.yMin, yMax: box.yMax },
    isValid: true,
  };
}

/** 输出层需要的来源与免责字段（AGENTS.md 十一.1）。 */
export const SECTION_PROVENANCE = {
  method: 'polygon_second_moment_integral',
  formulas: [
    'A = 1/2 * Σ (x_i*y_{i+1} - x_{i+1}*y_i)',
    'Ix_origin = 1/12 * Σ cross * (y0^2 + y0*y1 + y1^2)',
    'Iy_origin = 1/12 * Σ cross * (x0^2 + x0*x1 + x1^2)',
    'Ixy_origin = 1/24 * Σ cross * (x0*y1 + 2*x0*y0 + 2*x1*y1 + x1*y0)',
    '平行轴定理转移到形心：Ix_c = Ix_origin - A*cy^2',
    '主轴：I = (Ix+Iy)/2 ± sqrt(((Ix-Iy)/2)^2 + Ixy^2)',
    'W = I / e（e 为形心到最外纤维距离）',
  ],
  assumptions: [
    '截面为直杆匀质截面，材料各向同性',
    '轮廓为直线段围成的多边形，曲边需离散到足够精度',
    '轮廓必须是简单多边形，孔洞位于外轮廓内部且互不重叠（已在校验层强制）',
    '孔洞绕向自动归一，净面积必须为正',
  ],
  limitations: [
    '未实现扭转常数 J（开口/闭口薄壁需专门近似方法）',
    '未实现截面剪力中心 shearCenter（薄壁开口截面受扭必需，列入 M1）',
    '未做局部屈曲与焊缝折减，结果不代表承载能力认证',
    `轮廓顶点数上限 ${MAX_CONTOUR_VERTICES}（自交与孔洞校验为 O(n^2)）`,
  ],
  validation: {
    selfIntersection: 'rejected',
    holeTopology: 'rejected',
    maxVerticesPerContour: MAX_CONTOUR_VERTICES,
    originShift: 'bbox_center',
  },
  exactForPolygon: true as const,
  disclaimer: '截面特性为几何量，不含安全系数与许用值；不得用于免除结构校核责任。',
} as const;

export type SectionProvenance = typeof SECTION_PROVENANCE;

/** 有效数字清理：只影响输出，不影响内部计算。 */
export function sig(v: number, digits: number = TOL.outputSignificant): Ratio {
  if (!Number.isFinite(v)) return v as Ratio;
  if (v === 0) return 0 as Ratio;
  const mag = Math.floor(Math.log10(Math.abs(v)));
  const factor = 10 ** (digits - 1 - mag);
  return U.ratio(Math.round(v * factor) / factor);
}
