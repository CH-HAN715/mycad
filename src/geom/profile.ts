import type { Vec2 } from './polygon.ts';
import { GeometryInputError, v2 } from './polygon.ts';

/**
 * L1 截面参数化 DSL：用工程尺寸描述一根铝型材的横截面，生成有向多边形。
 *
 * 一期只建模「直角理想化截面」：直边 T 槽 + 正多边形中心孔。
 * 圆角、倒角、非对称槽位不在本期范围，provenance 必须如实标注。
 * 尺寸全部由调用方给出——本模块不内置任何供应商样本值，避免版权与过期数据问题。
 */

export interface SlotSpec {
  /** 槽口宽度（表面开口），mm。 */
  readonly opening: number;
  /** 从表面到槽底的总深度，mm。 */
  readonly depth: number;
  /** 槽内最宽处宽度（T 头宽度），mm，必须大于 opening。 */
  readonly headWidth: number;
  /** 从表面到 T 头起始处的深度，mm。 */
  readonly headStart: number;
}

export type ProfileFace = 'bottom' | 'right' | 'top' | 'left';

export interface BoreSpec {
  /** 中心孔内切圆半径，mm。 */
  readonly radius: number;
  /** 直接指定多边形边数（8..512）。与 sagitta 二选一。 */
  readonly segments?: number;
  /** 弦高容差，mm；默认 0.01。边数由它反算。 */
  readonly sagitta?: number;
}

export interface ProfileSpec {
  readonly width: number;
  readonly height: number;
  readonly slot?: SlotSpec;
  readonly slotFaces?: readonly ProfileFace[];
  readonly bore?: BoreSpec;
}

export interface ProfileMeta {
  readonly slotCount: number;
  readonly slotFaces: readonly ProfileFace[];
  readonly boreRadius: number;
  readonly boreSegments: number;
  /** 正多边形孔的面积（不是 πr²），用于报告面积闭合。 */
  readonly boreArea: number;
}

export interface ProfileGeometry {
  readonly outer: readonly Vec2[];
  readonly holes: readonly (readonly Vec2[])[];
  readonly meta: ProfileMeta;
}

export const ALL_FACES: readonly ProfileFace[] = ['bottom', 'right', 'top', 'left'];
const DEFAULT_BORE_SAGITTA = 0.01;
const MIN_BORE_SEGMENTS = 8;
const MAX_BORE_SEGMENTS = 512;

/** 参数化截面模型的来源与边界声明（AGENTS.md 第十一节）。 */
export const PROFILE_PROVENANCE = {
  model: 'straight_edge_idealized_profile',
  supported: [
    '矩形外框（宽 × 高）',
    '直边 T 槽：开口段 + 更宽的 T 头段',
    '正多边形中心孔（边数由弦高容差反算）',
    '四个面可独立开关槽位',
  ],
  notModeled: ['圆角与倒角', '非对称槽位', '空心减重腔与筋板', '供应商样本尺寸'],
  disclaimer: '参数化截面只描述几何；尺寸由调用方提供，不代表任何厂商型号或标准，也不含材料与安全系数。',
} as const;

function fail(message: string, hint: string): never {
  throw new GeometryInputError(message, hint, 'degenerate');
}

function requirePositive(value: number, what: string): void {
  if (!Number.isFinite(value) || !(value > 0)) {
    fail(`${what} 必须是正的有限数，收到 ${value}`, '所有尺寸单位为 mm，且必须大于 0');
  }
}

function normalizeFaces(faces: readonly ProfileFace[] | undefined): readonly ProfileFace[] {
  if (faces === undefined) return ALL_FACES;
  const seen = new Set<ProfileFace>();
  for (const face of faces) {
    if (!ALL_FACES.includes(face)) fail(`未知的槽面：${String(face)}`, `可用：${ALL_FACES.join('、')}`);
    if (seen.has(face)) fail(`槽面重复：${face}`, '每个面最多一个槽');
    seen.add(face);
  }
  return [...seen];
}

function validateSlot(slot: SlotSpec, width: number, height: number, faces: readonly ProfileFace[]): void {
  requirePositive(slot.opening, '槽口宽 opening');
  requirePositive(slot.depth, '槽深 depth');
  requirePositive(slot.headStart, 'T 头起始深度 headStart');
  requirePositive(slot.headWidth, 'T 头宽 headWidth');

  if (slot.headStart >= slot.depth) {
    fail(
      `headStart（${slot.headStart}）必须小于 depth（${slot.depth}）`,
      'T 槽结构为：表面开口段 headStart，随后是更宽的 T 头段 headStart..depth',
    );
  }
  if (!(slot.headWidth > slot.opening)) {
    fail(
      `headWidth（${slot.headWidth}）必须大于 opening（${slot.opening}）`,
      '否则不是 T 槽，而是直槽或倒 T 槽，当前模型不支持',
    );
  }

  // 邻面槽不得互相侵入：T 头半宽 + 槽深 必须小于半边长，否则两个槽在角部相交。
  const halfMin = Math.min(width, height) / 2;
  if (slot.headWidth / 2 + slot.depth >= halfMin) {
    fail(
      `槽在角部相交：headWidth/2 + depth = ${(slot.headWidth / 2 + slot.depth).toFixed(3)} mm，` +
        `必须小于 min(width,height)/2 = ${halfMin.toFixed(3)} mm`,
      '减小 headWidth 或 depth，或只在不相邻的面开槽',
    );
  }
}

function resolveBoreSegments(bore: BoreSpec): number {
  requirePositive(bore.radius, '中心孔半径 radius');
  if (bore.segments !== undefined) {
    if (!Number.isInteger(bore.segments) || bore.segments < MIN_BORE_SEGMENTS || bore.segments > MAX_BORE_SEGMENTS) {
      fail(
        `中心孔边数必须在 ${MIN_BORE_SEGMENTS}..${MAX_BORE_SEGMENTS} 之间，收到 ${bore.segments}`,
        '边数太少会让孔的面积与惯性矩显著偏小；太多则无谓增加顶点数',
      );
    }
    return bore.segments;
  }
  const sagitta = bore.sagitta ?? DEFAULT_BORE_SAGITTA;
  requirePositive(sagitta, '中心孔弦高 sagitta');
  const cosHalf = 1 - sagitta / bore.radius;
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, cosHalf)));
  const segments = Math.ceil((2 * Math.PI) / step);
  return Math.max(MIN_BORE_SEGMENTS, Math.min(MAX_BORE_SEGMENTS, segments));
}

/** 正多边形孔：外接圆半径 r，边数 n，从 0° 起逆时针。 */
export function circlePolygon(radius: number, segments: number): Vec2[] {
  const points: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = (2 * Math.PI * i) / segments;
    points.push(v2(radius * Math.cos(angle), radius * Math.sin(angle)));
  }
  return points;
}

/** 正多边形精确面积与绕形心惯性矩（与积分实现完全独立的闭式解，用于对账）。 */
export function regularPolygonProperties(radius: number, segments: number): {
  readonly area: number;
  readonly ix: number;
  readonly iy: number;
} {
  const area = (segments / 2) * radius * radius * Math.sin((2 * Math.PI) / segments);
  const polar = (area * radius * radius * (1 + 2 * Math.cos(Math.PI / segments) ** 2)) / 6;
  return { area, ix: polar / 2, iy: polar / 2 };
}

/**
 * 在一条从 a 到 b 的面上生成 T 槽轮廓。
 * 约定：多边形按 CCW 遍历，内部在行进方向左侧，因此左法向即「向材料内部」。
 */
function slotOutline(a: Vec2, b: Vec2, slot: SlotSpec): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  // 左法向 = 旋转 +90°。
  const nx = -uy;
  const ny = ux;
  const cx = (a.x + b.x) / 2;
  const cy = (a.y + b.y) / 2;

  const at = (along: number, into: number): Vec2 => v2(cx + ux * along + nx * into, cy + uy * along + ny * into);

  const halfOpening = slot.opening / 2;
  const halfHead = slot.headWidth / 2;
  return [
    at(-halfOpening, 0),
    at(-halfOpening, slot.headStart),
    at(-halfHead, slot.headStart),
    at(-halfHead, slot.depth),
    at(halfHead, slot.depth),
    at(halfHead, slot.headStart),
    at(halfOpening, slot.headStart),
    at(halfOpening, 0),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${where}.${key} 必须是有限数，收到 ${JSON.stringify(value)}`, '所有尺寸单位为 mm');
  }
  return value;
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(`${where} 含未知字段：${key}`, `允许的字段：${allowed.join('、')}；拼写错误不会被静默忽略`);
    }
  }
}

/**
 * 解析并校验 agent/用户提交的 ProfileSpec JSON。
 * 未知字段直接拒绝——拼错的 dimensions 不能被静默当成默认值，否则会算出一个看似合理的错截面。
 */
export function parseProfileSpec(raw: unknown): ProfileSpec {
  if (!isRecord(raw)) fail('型材规格必须是 JSON 对象', '形如 {"width":20,"height":20,"slot":{...}}');
  assertKnownKeys(raw, ['width', 'height', 'slot', 'slotFaces', 'bore'], '型材规格');

  const width = readNumber(raw, 'width', '型材规格');
  const height = readNumber(raw, 'height', '型材规格');

  let slot: SlotSpec | undefined;
  if (raw['slot'] !== undefined) {
    const rawSlot = raw['slot'];
    if (!isRecord(rawSlot)) fail('slot 必须是对象', 'slot 需包含 opening、depth、headWidth、headStart');
    assertKnownKeys(rawSlot, ['opening', 'depth', 'headWidth', 'headStart'], 'slot');
    slot = {
      opening: readNumber(rawSlot, 'opening', 'slot'),
      depth: readNumber(rawSlot, 'depth', 'slot'),
      headWidth: readNumber(rawSlot, 'headWidth', 'slot'),
      headStart: readNumber(rawSlot, 'headStart', 'slot'),
    };
  }

  let slotFaces: readonly ProfileFace[] | undefined;
  if (raw['slotFaces'] !== undefined) {
    const rawFaces = raw['slotFaces'];
    if (!Array.isArray(rawFaces)) fail('slotFaces 必须是数组', `可用取值：${ALL_FACES.join('、')}`);
    slotFaces = rawFaces.map((face, i) => {
      if (typeof face !== 'string' || !ALL_FACES.includes(face as ProfileFace)) {
        fail(`slotFaces[${i}] 非法：${JSON.stringify(face)}`, `可用取值：${ALL_FACES.join('、')}`);
      }
      return face as ProfileFace;
    });
  }

  let bore: BoreSpec | undefined;
  if (raw['bore'] !== undefined) {
    const rawBore = raw['bore'];
    if (!isRecord(rawBore)) fail('bore 必须是对象', 'bore 需包含 radius，可选 segments 或 sagitta');
    assertKnownKeys(rawBore, ['radius', 'segments', 'sagitta'], 'bore');
    const radius = readNumber(rawBore, 'radius', 'bore');
    const segments = rawBore['segments'] === undefined ? undefined : readNumber(rawBore, 'segments', 'bore');
    const sagitta = rawBore['sagitta'] === undefined ? undefined : readNumber(rawBore, 'sagitta', 'bore');
    bore = {
      radius,
      ...(segments !== undefined ? { segments } : {}),
      ...(sagitta !== undefined ? { sagitta } : {}),
    };
  }

  return {
    width,
    height,
    ...(slot !== undefined ? { slot } : {}),
    ...(slotFaces !== undefined ? { slotFaces } : {}),
    ...(bore !== undefined ? { bore } : {}),
  };
}

export function buildProfile(spec: ProfileSpec): ProfileGeometry {
  requirePositive(spec.width, '截面宽 width');
  requirePositive(spec.height, '截面高 height');

  const faces = normalizeFaces(spec.slotFaces);
  if (spec.slot !== undefined && faces.length > 0) validateSlot(spec.slot, spec.width, spec.height, faces);
  if (spec.slot === undefined && faces.length > 0 && spec.slotFaces !== undefined) {
    fail('声明了 slotFaces 但没有给出 slot 尺寸', '要么省略 slotFaces，要么补上 slot 参数');
  }

  const halfWidth = spec.width / 2;
  const halfHeight = spec.height / 2;
  // CCW 角点顺序：左下 → 右下 → 右上 → 左上。
  const corners: readonly (readonly [Vec2, Vec2, ProfileFace])[] = [
    [v2(-halfWidth, -halfHeight), v2(halfWidth, -halfHeight), 'bottom'],
    [v2(halfWidth, -halfHeight), v2(halfWidth, halfHeight), 'right'],
    [v2(halfWidth, halfHeight), v2(-halfWidth, halfHeight), 'top'],
    [v2(-halfWidth, halfHeight), v2(-halfWidth, -halfHeight), 'left'],
  ];
  const activeFaces = new Set(faces);

  const outer: Vec2[] = [];
  for (const [a, b, face] of corners) {
    outer.push(a);
    if (spec.slot !== undefined && activeFaces.has(face)) outer.push(...slotOutline(a, b, spec.slot));
  }

  const holes: Vec2[][] = [];
  let boreSegments = 0;
  let boreArea = 0;
  if (spec.bore !== undefined) {
    boreSegments = resolveBoreSegments(spec.bore);
    const radius = spec.bore.radius;
    const halfMin = Math.min(spec.width, spec.height) / 2;
    const clearance = faces.length > 0 && spec.slot !== undefined ? halfMin - spec.slot.depth : halfMin;
    if (radius >= clearance) {
      fail(
        `中心孔半径 ${radius} mm 与槽或外壁冲突：必须小于 ${clearance.toFixed(3)} mm`,
        '减小孔径或槽深；孔与槽之间必须留出材料',
      );
    }
    const bore = circlePolygon(radius, boreSegments);
    boreArea = regularPolygonProperties(radius, boreSegments).area;
    holes.push(bore);
  }

  return {
    outer,
    holes,
    meta: {
      slotCount: spec.slot !== undefined ? faces.length : 0,
      slotFaces: faces,
      boreRadius: spec.bore?.radius ?? 0,
      boreSegments,
      boreArea,
    },
  };
}
