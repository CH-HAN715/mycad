import type { Axis, FrameInput, FrameModel, ResolvedMember, ResolvedProfile } from '../frame/model.ts';
import { parseFrameInput } from '../frame/model.ts';
import type { ProfileFace } from '../geom/profile.ts';
import type { Mm } from '../geom/units.ts';
import { U } from '../geom/units.ts';
import type { Vec3 } from '../geom/vec3.ts';
import { matchFastenerSeries, parseRulesOverride } from './rules.ts';
import type { ConnectRules, FastenerSeriesRule } from './rules.ts';
import { DEFAULT_CONNECT_RULES } from './rules.ts';

/**
 * L3 连接层 v1：从已求解的框架模型出发，分类关节、选择连接件、生成孔位与让量建议。
 *
 * 截面方向约定（本层定义，供孔位与角件布置使用）：
 * - 杆件轴 a，截面局部 u、v 按 x→(y,z)、y→(x,z)、z→(x,y) 固定映射。
 * - DSL 面法向：bottom=-v、top=+v、left=-u、right=+u。
 * - 角件只放在「法向垂直于关节平面」的槽面上；形状不建模，只出孔位与数量。
 *
 * 一期只自动处理：两面角（corner）、T 接（tee）、同轴对接（splice）。
 * 三面及以上的角、斜接、端面攻丝不自动选型——标成 manual 并给出原因，不猜。
 */

export type JointKind = 'corner' | 'tee' | 'splice' | 'undecided';
export type ConnectStrategy = 'angle-bracket' | 'internal-peg' | 'manual';

export class ConnectError extends Error {
  readonly code = 'E_INPUT_CONNECT';
  readonly hint: string;
  readonly reason: string;

  constructor(message: string, hint: string, reason: string) {
    super(message);
    this.name = 'ConnectError';
    this.hint = hint;
    this.reason = reason;
  }
}

const SECTION_FRAME: Record<Axis, { u: Axis; v: Axis }> = {
  x: { u: 'y', v: 'z' },
  y: { u: 'x', v: 'z' },
  z: { u: 'x', v: 'y' },
} as const;

const ALL_AXES: readonly Axis[] = ['x', 'y', 'z'];

/** 两轴之外的第三轴。a、b 必须不同。 */
function thirdAxis(a: Axis, b: Axis): Axis {
  const found = ALL_AXES.find((axis) => axis !== a && axis !== b);
  if (found === undefined) throw new ConnectError(`无法为同轴 ${a} 求第三轴`, '内部错误：先检查关节分类', 'internal');
  return found;
}

const coordOf = (p: Vec3, axis: Axis): number => p[axis];

const FACE_BY_NORMAL: Record<'u' | 'v', Record<'-' | '+', ProfileFace>> = {
  v: { '-': 'bottom', '+': 'top' },
  u: { '-': 'left', '+': 'right' },
} as const;

export interface ConnectorHole {
  readonly memberId: string;
  /** start/end：杆件端头孔；interior：T 接穿通杆侧面孔。 */
  readonly at: 'start' | 'end' | 'interior';
  readonly face: ProfileFace;
  /** 距关节侧端面的距离，mm（at=interior 时为 null）。 */
  readonly fromJointEndMm: Mm | null;
  /** 沿杆件轴从 start 端算起的位置，mm（at=interior 时有值）。 */
  readonly alongStartMm: Mm | null;
  /** 截面局部坐标 (u, v)，mm。 */
  readonly localU: Mm;
  readonly localV: Mm;
  /** 螺栓轴线方向（全局轴）。 */
  readonly boltAxis: Axis;
  readonly boltSeries: string;
  /** 公称直径，mm；无法从系列解析时为 null。 */
  readonly diameterMm: number | null;
  /** 通光孔钻孔直径，mm（ISO 273 中系列公开表）；系列不在表内为 null。 */
  readonly clearanceDrillMm: number | null;
  /** 攻丝底孔直径，mm；仅当工艺选择攻丝时使用。 */
  readonly tapDrillMm: number | null;
  /** 孔深，mm；null 表示按通孔输出（一期不做盲孔）。 */
  readonly depthMm: number | null;
}

export interface HardwareItem {
  readonly kind: 'angle-bracket' | 'slot-nut' | 'bolt' | 'peg';
  readonly label: string;
  readonly size: string | null;
  readonly lengthMm: Mm | null;
  readonly quantity: number;
  readonly sourceNote: string;
}

export interface RecommendedTrim {
  readonly memberId: string;
  readonly end: 'start' | 'end';
  readonly trimMm: Mm;
  readonly reason: string;
}

export interface JointPlan {
  readonly index: number;
  readonly point: Vec3;
  readonly kind: JointKind;
  readonly strategy: ConnectStrategy;
  readonly ends: readonly { memberId: string; end: 'start' | 'end'; axis: Axis }[];
  /** T 接中穿通的杆件 id。 */
  readonly throughMemberId: string | null;
  readonly holes: readonly ConnectorHole[];
  readonly hardware: readonly HardwareItem[];
  readonly recommendedTrims: readonly RecommendedTrim[];
  readonly warnings: readonly string[];
}

export interface ConnectPlan {
  readonly joints: readonly JointPlan[];
  readonly hardwareSummary: readonly { key: string; kind: HardwareItem['kind']; label: string; size: string | null; lengthMm: Mm | null; quantity: number }[];
  readonly singleEnds: readonly string[];
  readonly rules: ConnectRules;
}

export const CONNECT_PROVENANCE = {
  model: 'slot_based_connector_rules_v1',
  method: '按端点聚类与穿通检测分类关节；槽口宽按规则表映射紧固件系列；角件孔位按端距+间距展开',
  sectionFrameConvention: 'x→(u=y,v=z)，y→(u=x,v=z)，z→(u=x,v=y)；bottom=-v，top=+v，left=-u，right=+u',
  buttConvention: '角接时杆件顺序在前者的端头按后者半边宽让量；T 接固定端头杆让穿通杆；对接不让量',
  assumptions: [
    '连接件只利用既有槽面，不在杆件侧面新增钻孔（T 接侧面孔按槽面螺栓近似）',
    '角件形状与孔距按规则表统一间距近似，实物角件必须复核',
    '螺栓长度为「立边厚+螺母垫圈余量」的建议值，不是采购规格',
    '内置对接棒只给几何近似，攻丝与棒材来源不在一期',
  ],
  limitations: [
    '三面及以上的角、非正交连接输出为 manual，不自动选型',
    '不校验角件与槽内其他紧固件的实占干涉',
    '不含零件号与供应商目录，输出为通用类型',
    '让量建议未计入角件与槽口的配合公差',
  ],
  disclaimer:
    '连接件选型与孔位为规则引擎近似结果，数值为工程惯例而非规范条文；投产前必须按实际零件与工艺复核。',
} as const;

function boltDiameterOf(series: string): number | null {
  const m = /^M(\d+(?:\.\d+)?)$/.exec(series.trim());
  return m === null ? null : Number(m[1]);
}

/** 钻孔直径按系列查规则表；不在表内返回 null，由图纸显式标 UNKNOWN，不猜值。 */
function drillDiametersOf(
  series: string,
  rules: ConnectRules,
): { readonly clearance: number | null; readonly tap: number | null } {
  return {
    clearance: rules.clearanceDrillBySeries[series] ?? null,
    tap: rules.tapDrillBySeries[series] ?? null,
  };
}

interface MemberContext {
  readonly member: ResolvedMember;
  readonly profile: ResolvedProfile;
  /** 距给定点更近的端头。 */
  endAt(point: Vec3): 'start' | 'end';
}

function makeContext(member: ResolvedMember, profile: ResolvedProfile): MemberContext {
  const endAt = (point: Vec3): 'start' | 'end' => {
    const dist = (p: Vec3): number =>
      Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z);
    return dist(member.start) <= dist(member.end) ? 'start' : 'end';
  };
  return { member, profile, endAt };
}

function faceWithNormal(ctx: MemberContext, sign: '+' | '-', wantAxis: Axis): ProfileFace | null {
  const frame = SECTION_FRAME[ctx.member.axis];
  if (wantAxis === frame.v) return FACE_BY_NORMAL.v[sign];
  if (wantAxis === frame.u) return FACE_BY_NORMAL.u[sign];
  return null; // 法向沿杆件轴＝端面，角件策略不处理
}

function faceWidthMm(ctx: MemberContext, face: ProfileFace): number {
  const spec = ctx.profile.spec;
  return face === 'top' || face === 'bottom' ? spec.width : spec.height;
}

function localPositionOf(face: ProfileFace, spec: { width: number; height: number }): { u: number; v: number } {
  switch (face) {
    case 'bottom':
      return { u: 0, v: -spec.height / 2 };
    case 'top':
      return { u: 0, v: spec.height / 2 };
    case 'left':
      return { u: -spec.width / 2, v: 0 };
    case 'right':
      return { u: spec.width / 2, v: 0 };
  }
}

function isFaceSlotted(ctx: MemberContext, face: ProfileFace): boolean {
  if (ctx.profile.spec.slot === undefined) return false;
  return ctx.profile.meta.slotFaces.includes(face);
}

type SeriesResult = { readonly rule: FastenerSeriesRule; readonly opening: number } | string;

function seriesFor(ctx: MemberContext, rules: ConnectRules): SeriesResult {
  const slot = ctx.profile.spec.slot;
  if (slot === undefined) return `杆件 ${ctx.member.id} 的型材没有槽（slot 未定义），无法在槽面安装角件`;
  const match = matchFastenerSeries(rules, slot.opening);
  if (match.matched) return { rule: match.rule, opening: slot.opening };
  return `杆件 ${ctx.member.id}：${match.reason}`;
}

/** 一面能放的螺栓数：可用宽度按边距扣除后按间距展开。放不下返回 0。 */
function holeCountForFace(faceWidth: number, rules: ConnectRules): number {
  const usable = faceWidth - 2 * rules.bracketEdgeMarginMm;
  if (usable < rules.bracketHolePitchMm) return usable >= 1 ? 1 : 0;
  return Math.floor(usable / rules.bracketHolePitchMm) + 1;
}

function pushEndHoles(
  holes: ConnectorHole[],
  ctx: MemberContext,
  end: 'start' | 'end',
  face: ProfileFace,
  count: number,
  boltAxis: Axis,
  series: string,
  rules: ConnectRules,
): void {
  const diameter = boltDiameterOf(series);
  const drill = drillDiametersOf(series, rules);
  const local = localPositionOf(face, ctx.profile.spec);
  for (let k = 0; k < count; k++) {
    holes.push({
      memberId: ctx.member.id,
      at: end,
      face,
      fromJointEndMm: U.mm(rules.bracketHoleOffsetFromEndMm + k * rules.bracketHolePitchMm),
      alongStartMm: null,
      localU: U.mm(local.u),
      localV: U.mm(local.v),
      boltAxis,
      boltSeries: series,
      diameterMm: diameter,
      clearanceDrillMm: drill.clearance,
      tapDrillMm: drill.tap,
      depthMm: null,
    });
  }
}

function halfExtentAlong(ctx: MemberContext, axis: Axis): Mm {
  const frame = SECTION_FRAME[ctx.member.axis];
  const spec = ctx.profile.spec;
  if (axis === frame.u) return U.mm(spec.width / 2);
  if (axis === frame.v) return U.mm(spec.height / 2);
  throw new ConnectError(
    `杆件 ${ctx.member.id} 的轴向就是 ${axis}，不存在沿自身轴的截面半宽`,
    '内部错误：检查关节分类',
    'internal',
  );
}

function manualJoint(
  index: number,
  point: Vec3,
  kind: JointKind,
  ends: JointPlan['ends'],
  warnings: string[],
  throughMemberId: string | null = null,
): JointPlan {
  return { index, point, kind, strategy: 'manual', ends, throughMemberId, holes: [], hardware: [], recommendedTrims: [], warnings };
}

function planBracketJoint(
  jointIndex: number,
  kind: 'corner' | 'tee',
  endCtx: MemberContext,
  otherCtx: MemberContext,
  point: Vec3,
  ends: JointPlan['ends'],
  rules: ConnectRules,
): JointPlan {
  const warnings: string[] = [];
  const holes: ConnectorHole[] = [];

  const boltAxis = thirdAxis(endCtx.member.axis, otherCtx.member.axis);
  const seriesEnd = seriesFor(endCtx, rules);
  const seriesOther = seriesFor(otherCtx, rules);
  if (typeof seriesEnd === 'string' || typeof seriesOther === 'string') {
    warnings.push(...[seriesEnd, seriesOther].filter((w): w is string => typeof w === 'string'));
    return manualJoint(jointIndex, point, kind, ends, [...warnings, '紧固件系列无法确定，改为 manual'], kind === 'tee' ? otherCtx.member.id : null);
  }

  let bracketCount = 0;
  for (const sign of ['-', '+'] as const) {
    const faceEnd = faceWithNormal(endCtx, sign, boltAxis);
    const faceOther = faceWithNormal(otherCtx, sign, boltAxis);
    if (faceEnd === null || faceOther === null) continue;
    if (!isFaceSlotted(endCtx, faceEnd) || !isFaceSlotted(otherCtx, faceOther)) {
      warnings.push(`法向 ${sign}${boltAxis} 侧的面（${faceEnd} / ${faceOther}）无槽或槽未开，该侧不放角件`);
      continue;
    }
    bracketCount += 1;

    const nEnd = holeCountForFace(faceWidthMm(endCtx, faceEnd), rules);
    const nOther = holeCountForFace(faceWidthMm(otherCtx, faceOther), rules);
    pushEndHoles(holes, endCtx, endCtx.endAt(point), faceEnd, nEnd, boltAxis, seriesEnd.rule.boltSeries, rules);

    if (kind === 'tee') {
      const lo = rules.bracketEdgeMarginMm;
      const hi = otherCtx.member.centerlineLength - lo;
      const along = coordOf(point, otherCtx.member.axis) -
        Math.min(coordOf(otherCtx.member.start, otherCtx.member.axis), coordOf(otherCtx.member.end, otherCtx.member.axis));
      const local = localPositionOf(faceOther, otherCtx.profile.spec);
      const drillOther = drillDiametersOf(seriesOther.rule.boltSeries, rules);
      for (let k = 0; k < nOther; k++) {
        const pos = along + (k - (nOther - 1) / 2) * rules.bracketHolePitchMm;
        if (pos < lo || pos > hi) {
          warnings.push(`穿通杆 ${otherCtx.member.id} 侧面第 ${k + 1} 个孔位 ${pos.toFixed(1)} mm 越出可用范围 [${lo}, ${hi.toFixed(1)}]，已跳过`);
          continue;
        }
        holes.push({
          memberId: otherCtx.member.id,
          at: 'interior',
          face: faceOther,
          fromJointEndMm: null,
          alongStartMm: U.mm(pos),
          localU: U.mm(local.u),
          localV: U.mm(local.v),
          boltAxis,
          boltSeries: seriesOther.rule.boltSeries,
          diameterMm: boltDiameterOf(seriesOther.rule.boltSeries),
          clearanceDrillMm: drillOther.clearance,
          tapDrillMm: drillOther.tap,
          depthMm: null,
        });
      }
    } else {
      pushEndHoles(holes, otherCtx, otherCtx.endAt(point), faceOther, nOther, boltAxis, seriesOther.rule.boltSeries, rules);
    }
  }

  if (bracketCount === 0) {
    warnings.push('所有候选面都没有可用槽，改为 manual');
    return manualJoint(jointIndex, point, kind, ends, warnings, kind === 'tee' ? otherCtx.member.id : null);
  }

  const boltTotal = holes.length;
  const boltLength = U.mm(rules.bracketLegThicknessMm + rules.nutWasherAllowanceMm);
  const hardware: HardwareItem[] = [
    {
      kind: 'angle-bracket',
      label: '角件（通用，无零件号）',
      size: seriesEnd.rule.boltSeries,
      lengthMm: null,
      quantity: bracketCount,
      sourceNote: `数量按两侧可用安装面配对得出；规则来源：${rules.source}`,
    },
    {
      kind: 'slot-nut',
      label: '槽用螺母/弹条',
      size: seriesEnd.rule.boltSeries,
      lengthMm: null,
      quantity: boltTotal,
      sourceNote: `槽口 ${seriesEnd.opening} mm → ${seriesEnd.rule.boltSeries}（${seriesEnd.rule.rationale}）`,
    },
    {
      kind: 'bolt',
      label: '六角螺栓（建议值）',
      size: seriesEnd.rule.boltSeries,
      lengthMm: boltLength,
      quantity: boltTotal,
      sourceNote: `长度=立边厚 ${rules.bracketLegThicknessMm}+螺母垫圈余量 ${rules.nutWasherAllowanceMm} mm，采购前按实物复核`,
    },
  ];

  const trim = halfExtentAlong(otherCtx, endCtx.member.axis);
  const trims: RecommendedTrim[] = [
    {
      memberId: endCtx.member.id,
      end: endCtx.endAt(point),
      trimMm: trim,
      reason: `${endCtx.member.id} 端头顶到 ${otherCtx.member.id} 侧面，让开其沿 ${endCtx.member.axis} 方向的半边宽 ${(trim as number).toFixed(3)} mm`,
    },
  ];

  return {
    index: jointIndex,
    point,
    kind,
    strategy: 'angle-bracket',
    ends,
    throughMemberId: kind === 'tee' ? otherCtx.member.id : null,
    holes,
    hardware,
    recommendedTrims: trims,
    warnings,
  };
}

function planSplice(
  jointIndex: number,
  ctxA: MemberContext,
  ctxB: MemberContext,
  point: Vec3,
  ends: JointPlan['ends'],
  rules: ConnectRules,
): JointPlan {
  const boreA = ctxA.profile.meta.boreRadius;
  const boreB = ctxB.profile.meta.boreRadius;
  if (boreA <= 0 || boreB <= 0) {
    return manualJoint(jointIndex, point, 'splice', ends, [
      `同轴对接需要中心孔装内置连接件；${ctxA.member.id} 孔半径 ${boreA}，${ctxB.member.id} 孔半径 ${boreB}，至少一个为 0，改为 manual`,
    ]);
  }
  const clearance = 0.5; // 棒与孔单边间隙：工程惯例，需实测复核
  const pegDiameter = 2 * Math.min(boreA, boreB) - clearance;
  if (pegDiameter <= 0) {
    return manualJoint(jointIndex, point, 'splice', ends, [
      `中心孔半径 ${Math.min(boreA, boreB)} mm 扣除间隙 ${clearance} mm 后无可用棒径，改为 manual`,
    ]);
  }
  const pegLength = U.mm(2 * rules.pegMinEngagementMm);
  const shortest = Math.min(ctxA.member.cutLength, ctxB.member.cutLength);
  if (pegLength / 2 > shortest) {
    return manualJoint(jointIndex, point, 'splice', ends, [
      `插入棒单侧深度 ${(pegLength / 2).toFixed(1)} mm 超过较短杆件全长 ${shortest.toFixed(1)} mm，改为 manual`,
    ]);
  }
  const hardware: HardwareItem[] = [
    {
      kind: 'peg',
      label: '内置对接棒（通用，无零件号）',
      size: `Ø${pegDiameter.toFixed(2)}`,
      lengthMm: pegLength,
      quantity: 1,
      sourceNote: `直径=最小中心孔直径−${clearance} mm 间隙；单侧旋合深度≥${rules.pegMinEngagementMm} mm；来源：${rules.source}`,
    },
  ];
  const trims: RecommendedTrim[] = ends.map((e) => ({
    memberId: e.memberId,
    end: e.end,
    trimMm: U.mm(0),
    reason: '同轴对接按端面相碰，无让量',
  }));
  return { index: jointIndex, point, kind: 'splice', strategy: 'internal-peg', ends, throughMemberId: null, holes: [], hardware, recommendedTrims: trims, warnings: [] };
}

function isInteriorPoint(ctx: MemberContext, point: Vec3, tol: number): boolean {
  const axis = ctx.member.axis;
  const lo = Math.min(coordOf(ctx.member.start, axis), coordOf(ctx.member.end, axis));
  const hi = Math.max(coordOf(ctx.member.start, axis), coordOf(ctx.member.end, axis));
  const along = coordOf(point, axis);
  if (along < lo + tol || along > hi - tol) return false;
  for (const a of ALL_AXES) {
    if (a === axis) continue;
    if (Math.abs(ctx.member.start[a] - point[a]) > tol) return false;
  }
  return true;
}

export interface ConnectOptions {
  readonly rules?: Record<string, unknown>;
}

export function planConnections(model: FrameModel, options: ConnectOptions = {}): ConnectPlan {
  let rules: ConnectRules;
  try {
    rules = options.rules === undefined ? DEFAULT_CONNECT_RULES : parseRulesOverride(options.rules);
  } catch (error) {
    throw new ConnectError(error instanceof Error ? error.message : String(error), 'rules 为浅合并覆盖，字段名见 src/connect/rules.ts', 'invalid_rules');
  }

  const profilesById = new Map(model.profiles.map((p) => [p.id, p]));
  const contexts = new Map<string, MemberContext>();
  for (const m of model.members) {
    const profile = profilesById.get(m.profileId);
    if (profile === undefined) {
      throw new ConnectError(`杆件 ${m.id} 引用未知型材 ${m.profileId}`, '框架模型不完整', 'unknown_profile');
    }
    contexts.set(m.id, makeContext(m, profile));
  }

  const jointTol = 1e-6; // 与 L4 关节聚类同一量级，只吸收浮点噪声
  const joints: JointPlan[] = [];
  const singleEnds: string[] = [];
  let index = 0;

  for (const joint of model.joints) {
    const ends: JointPlan['ends'] = joint.ends.map((e) => ({
      memberId: e.memberId,
      end: e.end,
      axis: contexts.get(e.memberId)!.member.axis,
    }));

    // 穿通检测必须先于悬空端点判定：T 接的关节只有一个端点
    const through = model.members.filter(
      (m) => !joint.ends.some((e) => e.memberId === m.id) && isInteriorPoint(contexts.get(m.id)!, joint.point, jointTol),
    );

    if (joint.ends.length === 1 && through.length === 0) {
      const e = joint.ends[0]!;
      singleEnds.push(`${e.memberId}.${e.end}`);
      continue;
    }

    if (through.length > 0) {
      if (through.length > 1 || joint.ends.length !== 1) {
        joints.push(manualJoint(index++, joint.point, 'undecided', ends, ['穿通杆与端点组合超出 v1 自动分类，改为人工'], through[0]!.id));
        continue;
      }
      const endCtx = contexts.get(joint.ends[0]!.memberId)!;
      const otherCtx = contexts.get(through[0]!.id)!;
      if (endCtx.member.axis === otherCtx.member.axis) {
        joints.push(manualJoint(index++, joint.point, 'undecided', ends, ['端点落在同轴杆件内部，属于对接错位，人工复核坐标'], otherCtx.member.id));
        continue;
      }
      joints.push(planBracketJoint(index++, 'tee', endCtx, otherCtx, joint.point, ends, rules));
      continue;
    }

    if (joint.ends.length === 2) {
      const ctxA = contexts.get(joint.ends[0]!.memberId)!;
      const ctxB = contexts.get(joint.ends[1]!.memberId)!;
      if (ctxA.member.axis === ctxB.member.axis) {
        joints.push(planSplice(index++, ctxA, ctxB, joint.point, ends, rules));
      } else {
        // 角接约定：框架 members 顺序在前的端头让量（可人工改 trim），另一个通长
        joints.push(planBracketJoint(index++, 'corner', ctxA, ctxB, joint.point, ends, rules));
      }
      continue;
    }

    joints.push(
      manualJoint(index++, joint.point, 'undecided', ends, [
        `${joint.ends.length} 个端点共点（如箱体角），v1 不自动选型，等待多面角规则或人工处理`,
      ]),
    );
  }

  const summary = new Map<string, { key: string; kind: HardwareItem['kind']; label: string; size: string | null; lengthMm: Mm | null; quantity: number }>();
  for (const joint of joints) {
    for (const item of joint.hardware) {
      const key = `${item.kind}|${item.size ?? ''}|${item.lengthMm ?? ''}`;
      const existing = summary.get(key);
      if (existing === undefined) summary.set(key, { key, kind: item.kind, label: item.label, size: item.size, lengthMm: item.lengthMm, quantity: item.quantity });
      else existing.quantity += item.quantity;
    }
  }

  return { joints, hardwareSummary: [...summary.values()], singleEnds, rules };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 解析 connect 输入：接受 {"frame": {...}, "options": {...}}，
 * 也接受裸框架 JSON（此时用默认规则）。
 */
export function parseConnectInput(raw: unknown): { frame: FrameInput; options: ConnectOptions } {
  if (isRecord(raw) && raw['frame'] !== undefined) {
    for (const key of Object.keys(raw)) {
      if (!['frame', 'options'].includes(key)) {
        throw new ConnectError(`connect 输入含未知字段：${key}`, '允许：frame、options', 'invalid_input');
      }
    }
    let options: ConnectOptions = {};
    const optionsRaw = raw['options'];
    if (optionsRaw !== undefined) {
      if (!isRecord(optionsRaw)) throw new ConnectError('options 必须是对象', '形如 {"rules": {...}}', 'invalid_input');
      for (const key of Object.keys(optionsRaw)) {
        if (key !== 'rules') throw new ConnectError(`options 含未知字段：${key}`, '一期 options 只支持 rules', 'invalid_input');
      }
      options = { rules: optionsRaw['rules'] as Record<string, unknown> };
    }
    return { frame: parseFrameInput(raw['frame']), options };
  }
  return { frame: parseFrameInput(raw), options: {} };
}
