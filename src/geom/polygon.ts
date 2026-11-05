import type { Mm, Mm2 } from './units.ts';
import { U } from './units.ts';
import { TOL } from './tolerance.ts';

export interface Vec2 {
  readonly x: Mm;
  readonly y: Mm;
}

export type ContourRole = 'outer' | 'hole';

/** 单一闭合轮廓。点列不重复首点，首尾隐式闭合。 */
export interface Contour {
  readonly role: ContourRole;
  readonly points: readonly Vec2[];
}

export interface BBox {
  readonly xMin: Mm;
  readonly xMax: Mm;
  readonly yMin: Mm;
  readonly yMax: Mm;
}

/**
 * 单条轮廓的顶点上限。自交与孔洞关系校验是 O(n^2)：2000 顶点约 0.4 s，
 * 5000 顶点约 2.6 s，再放大就是可被 agent 输入触发的性能陷阱。
 * 真实型材截面通常 20~200 个顶点，2000 已是充裕余量。这是工程约束，不是几何容差。
 */
export const MAX_CONTOUR_VERTICES = 2_000;

export const v2 = (x: number, y: number): Vec2 => ({ x: U.mm(x), y: U.mm(y) });

/** 鞋带公式。CCW 为正，CW 为负。 */
export function signedArea(points: readonly Vec2[]): Mm2 {
  const n = points.length;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return U.mm2(sum / 2);
}

export function bboxOf(points: readonly Vec2[]): BBox {
  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const p of points) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  return { xMin: U.mm(xMin), xMax: U.mm(xMax), yMin: U.mm(yMin), yMax: U.mm(yMax) };
}

export type GeometryErrorReason =
  | 'too_few_points'
  | 'too_many_vertices'
  | 'degenerate'
  | 'self_intersection'
  | 'hole_outside'
  | 'hole_overlap';

export class GeometryInputError extends Error {
  readonly code = 'E_INPUT_GEOMETRY';
  readonly reason: GeometryErrorReason;
  readonly hint: string;

  constructor(message: string, hint: string, reason: GeometryErrorReason = 'degenerate') {
    super(message);
    this.name = 'GeometryInputError';
    this.hint = hint;
    this.reason = reason;
  }
}

/** 去掉显式闭合点与相邻重复点，并校验最小点数。 */
function dedupe(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && Math.abs(p.x - last.x) <= TOL.coincide && Math.abs(p.y - last.y) <= TOL.coincide) continue;
    out.push({ x: p.x, y: p.y });
  }
  if (out.length > 1) {
    const first = out[0]!;
    const last = out[out.length - 1]!;
    if (Math.abs(first.x - last.x) <= TOL.coincide && Math.abs(first.y - last.y) <= TOL.coincide) out.pop();
  }
  return out;
}

/** 有向面积 = (b−a) × (c−a)。 */
function orient(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * 带尺度容差的符号判定。双精度下叉积的绝对误差约为 |ab|·|ac|·ε（ε≈2.2e-16），
 * TOL.orientRel 取 1e-12 比该误差大 4 个量级，能稳定吸收舍入噪声而不误判真实几何。
 */
function orientSign(a: Vec2, b: Vec2, c: Vec2): -1 | 0 | 1 {
  const value = orient(a, b, c);
  const scale = Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - a.x, c.y - a.y);
  if (scale === 0) return 0;
  const tol = TOL.orientRel * scale;
  if (value > tol) return 1;
  if (value < -tol) return -1;
  return 0;
}

/** 点是否落在线段 ab 上（含端点），要求先判定共线。 */
function onSegment(p: Vec2, a: Vec2, b: Vec2): boolean {
  if (orientSign(a, b, p) !== 0) return false;
  return (
    p.x >= Math.min(a.x, b.x) - TOL.coincide &&
    p.x <= Math.max(a.x, b.x) + TOL.coincide &&
    p.y >= Math.min(a.y, b.y) - TOL.coincide &&
    p.y <= Math.max(a.y, b.y) + TOL.coincide
  );
}

/** 两条闭线段是否相交（含端点接触与共线重叠）。 */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientSign(a, b, c);
  const o2 = orientSign(a, b, d);
  const o3 = orientSign(c, d, a);
  const o4 = orientSign(c, d, b);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  if (o1 === 0 && onSegment(c, a, b)) return true;
  if (o2 === 0 && onSegment(d, a, b)) return true;
  if (o3 === 0 && onSegment(a, c, d)) return true;
  if (o4 === 0 && onSegment(b, c, d)) return true;
  return false;
}

/**
 * 找出第一条与其它边非法相交的边。返回 [i, j] 或 null。
 * 相邻边允许共享端点；但共线折返（零面积尖刺）视为非法。
 */
export function findSelfIntersection(points: readonly Vec2[]): readonly [number, number] | null {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    for (let j = i + 1; j < n; j++) {
      const c = points[j]!;
      const d = points[(j + 1) % n]!;

      if (j === i + 1) {
        // 相邻边共享 b：只允许共线直行，不允许折返。
        if (orientSign(a, b, d) === 0 && (onSegment(d, a, b) || onSegment(a, b, d))) return [i, j];
        continue;
      }
      if (i === 0 && j === n - 1) {
        // 末边与首边共享 points[0]：同样只允许共线直行。
        if (orientSign(c, a, b) === 0 && (onSegment(b, c, a) || onSegment(c, a, b))) return [i, j];
        continue;
      }
      if (segmentsIntersect(a, b, c, d)) return [i, j];
    }
  }
  return null;
}

/**
 * 归一化轮廓：去重、校验简单性、按 role 强制绕向。
 * 外轮廓取 CCW（正面积），孔取 CW（负面积），这样惯性矩直接按代数和相加即可自动完成孔的扣除。
 * 输入绕向不可信——它可能来自 agent 生成的 JSON。
 */
export function normalizeContour(input: Contour): Contour {
  const points = dedupe(input.points);
  if (points.length < 3) {
    throw new GeometryInputError(
      `轮廓至少需要 3 个不重复顶点，收到 ${input.points.length} 个（去重后 ${points.length} 个）`,
      '检查是否把闭合多边形的首点重复写在了末尾，或顶点数不足',
      'too_few_points',
    );
  }
  if (points.length > MAX_CONTOUR_VERTICES) {
    throw new GeometryInputError(
      `轮廓顶点数 ${points.length} 超过上限 ${MAX_CONTOUR_VERTICES}`,
      '请减少顶点或先做曲线离散简化；当前校验为 O(n^2)',
      'too_many_vertices',
    );
  }

  const selfIntersection = findSelfIntersection(points);
  if (selfIntersection !== null) {
    const [i, j] = selfIntersection;
    throw new GeometryInputError(
      `轮廓自交：边 ${i}（点 ${i}→${i + 1}）与边 ${j}（点 ${j}→${j + 1}）相交或重叠`,
      '截面轮廓必须是简单多边形：不能自交、不能有零面积尖刺、不能有重复顶点',
      'self_intersection',
    );
  }

  const area = signedArea(points);
  if (Math.abs(area) < TOL.minArea) {
    throw new GeometryInputError(
      '轮廓面积为 0（全部共线）',
      '给出有实际面积的轮廓；共线点无法定义形心与惯性矩',
      'degenerate',
    );
  }
  const wantPositive = input.role === 'outer';
  const isPositive = area > 0;
  return { role: input.role, points: wantPositive === isPositive ? points : points.slice().reverse() };
}

export function normalizeContours(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[]): Contour[] {
  const result = normalizeSection(outer, holes);
  return [result.outer, ...result.holes];
}

export type PointLocation = 'inside' | 'outside' | 'boundary';

/** 点与闭合多边形的位置关系。边界优先判定，避免射线法在边界上的奇偶歧义。 */
export function locatePoint(p: Vec2, polygon: readonly Vec2[]): PointLocation {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    if (onSegment(p, polygon[i]!, polygon[(i + 1) % n]!)) return 'boundary';
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const xAtY = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < xAtY) inside = !inside;
    }
  }
  return inside ? 'inside' : 'outside';
}

function assertEdgesDisjoint(
  a: readonly Vec2[],
  b: readonly Vec2[],
  message: string,
  hint: string,
  reason: GeometryErrorReason,
): void {
  for (let i = 0; i < a.length; i++) {
    const a0 = a[i]!;
    const a1 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const b0 = b[j]!;
      const b1 = b[(j + 1) % b.length]!;
      if (segmentsIntersect(a0, a1, b0, b1)) {
        throw new GeometryInputError(`${message}：边 ${i} 与边 ${j} 相交`, hint, reason);
      }
    }
  }
}

/**
 * 校验孔洞拓扑：每个孔必须完全位于外轮廓内部，孔与孔之间不得相交、不得嵌套。
 * 这是「代数相减」成立的前提——不校验就会把外面的孔也扣掉，静默算错。
 */
export function validateHoleTopology(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[]): void {
  for (let h = 0; h < holes.length; h++) {
    const hole = holes[h]!;
    assertEdgesDisjoint(
      outer,
      hole,
      `孔洞 ${h} 与外轮廓相交`,
      '孔洞必须完全位于外轮廓内部；如需开口，请把缺口直接画进外轮廓',
      'hole_outside',
    );
    for (let i = 0; i < hole.length; i++) {
      if (locatePoint(hole[i]!, outer) !== 'inside') {
        throw new GeometryInputError(
          `孔洞 ${h} 的顶点 ${i} 不在外轮廓内部`,
          '孔洞必须是外轮廓内部的闭合环，且不能贴边',
          'hole_outside',
        );
      }
    }
  }

  for (let a = 0; a < holes.length; a++) {
    for (let b = a + 1; b < holes.length; b++) {
      const holeA = holes[a]!;
      const holeB = holes[b]!;
      assertEdgesDisjoint(
        holeA,
        holeB,
        `孔洞 ${a} 与孔洞 ${b} 相交`,
        '孔洞之间必须互不重叠、互不嵌套；重叠会重复扣面积',
        'hole_overlap',
      );
      if (locatePoint(holeB[0]!, holeA) !== 'outside' || locatePoint(holeA[0]!, holeB) !== 'outside') {
        throw new GeometryInputError(
          `孔洞 ${a} 与孔洞 ${b} 存在包含关系`,
          '孔洞之间必须互不重叠、互不嵌套；嵌套孔请合并为一个孔洞',
          'hole_overlap',
        );
      }
    }
  }
}

export interface NormalizedSection {
  readonly outer: Contour;
  readonly holes: readonly Contour[];
}

/**
 * 截面几何的统一入口：归一化外轮廓与孔洞，并校验孔洞拓扑。
 * 所有上层计算都必须经过这里，禁止绕过校验直接用原始点列做代数相减。
 */
export function normalizeSection(
  outer: readonly Vec2[],
  holes: readonly (readonly Vec2[])[] = [],
): NormalizedSection {
  const outerContour = normalizeContour({ role: 'outer', points: outer });
  const holeContours = holes.map((hole) => normalizeContour({ role: 'hole', points: hole }));
  validateHoleTopology(
    outerContour.points,
    holeContours.map((c) => c.points),
  );
  return { outer: outerContour, holes: holeContours };
}

/** 矩形轮廓，中心可选对齐到形心原点。x 方向宽 b，y 方向高 h。 */
export function rectContour(b: number, h: number, role: ContourRole = 'outer'): Contour {
  if (!(b > 0) || !(h > 0)) throw new GeometryInputError(`矩形边长必须为正，收到 b=${b} h=${h}`, 'b 为 x 方向宽，h 为 y 方向高');
  return normalizeContour({
    role,
    points: [v2(0, 0), v2(b, 0), v2(b, h), v2(0, h)],
  });
}

/** 以原点为中心的矩形轮廓，用于对称截面的手算对照。 */
export function centeredRectContour(b: number, h: number, role: ContourRole = 'outer'): Contour {
  return normalizeContour({
    role,
    points: [v2(-b / 2, -h / 2), v2(b / 2, -h / 2), v2(b / 2, h / 2), v2(-b / 2, h / 2)],
  });
}
