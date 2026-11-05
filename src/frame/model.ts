import type { ProfileMeta, ProfileSpec } from '../geom/profile.ts';
import { buildProfile, parseProfileSpec } from '../geom/profile.ts';
import { sectionProperties } from '../geom/inertia.ts';
import { TOL } from '../geom/tolerance.ts';
import type { Kg, Mm, Mm2, Mm3 } from '../geom/units.ts';
import { U } from '../geom/units.ts';
import type { Vec3 } from '../geom/vec3.ts';
import { distance3, v3 } from '../geom/vec3.ts';

/**
 * L4 装配层：轴对齐杆件框架。
 *
 * 只建模「中心线 + 端部让量」的杆件几何。连接件实际让量、端面斜切、
 * 钻孔与铣槽都不在本层——下料长度由用户按连接件确认后通过 trim 传入，
 * 默认 0 表示按中心线长度下料，不包含任何连接件让量。
 */

export type Axis = 'x' | 'y' | 'z';

/** 关节聚类容差，mm。1e-6 mm = 1 nm，远小于任何加工公差，只吸收浮点噪声。 */
const JOINT_TOL_MM = 1e-6;

/** 端点让量默认值：0 表示不做任何连接件让量。 */
const DEFAULT_TRIM = 0;

export interface MaterialSpec {
  readonly name?: string;
  /** 密度，kg/m^3。必须由用户提供来源，本模块不内置材料库。 */
  readonly densityKgPerM3: number;
}

export interface FrameProfileInput {
  readonly id: string;
  readonly spec: ProfileSpec;
  readonly material?: MaterialSpec;
}

export interface FrameMemberInput {
  readonly id: string;
  readonly profileId: string;
  readonly start: Vec3;
  readonly end: Vec3;
  /** 起点端让量，mm。从中心线长度中扣除。 */
  readonly trimStart?: number;
  /** 终点端让量，mm。从中心线长度中扣除。 */
  readonly trimEnd?: number;
}

export interface FrameInput {
  readonly profiles: readonly FrameProfileInput[];
  readonly members: readonly FrameMemberInput[];
}

export type FrameErrorReason =
  | 'invalid_input'
  | 'duplicate_id'
  | 'unknown_profile'
  | 'degenerate_member'
  | 'not_axis_aligned'
  | 'negative_trim'
  | 'non_positive_cut_length'
  | 'overlapping_members';

export class FrameInputError extends Error {
  readonly code = 'E_INPUT_FRAME';
  readonly hint: string;
  readonly reason: FrameErrorReason;

  constructor(message: string, hint: string, reason: FrameErrorReason) {
    super(message);
    this.name = 'FrameInputError';
    this.hint = hint;
    this.reason = reason;
  }
}

function fail(message: string, hint: string, reason: FrameErrorReason): never {
  throw new FrameInputError(message, hint, reason);
}

export interface ResolvedProfile {
  readonly id: string;
  readonly spec: ProfileSpec;
  readonly meta: ProfileMeta;
  readonly area: Mm2;
  readonly material: MaterialSpec | null;
}

export interface ResolvedMember {
  readonly id: string;
  readonly profileId: string;
  readonly axis: Axis;
  readonly start: Vec3;
  readonly end: Vec3;
  readonly centerlineLength: Mm;
  readonly trimStart: Mm;
  readonly trimEnd: Mm;
  readonly cutLength: Mm;
  readonly area: Mm2;
  readonly volume: Mm3;
  readonly mass: Kg | null;
}

export interface JointEnd {
  readonly memberId: string;
  readonly end: 'start' | 'end';
}

export interface FrameJoint {
  readonly point: Vec3;
  readonly ends: readonly JointEnd[];
  readonly memberCount: number;
}

export interface FrameModel {
  readonly profiles: readonly ResolvedProfile[];
  readonly members: readonly ResolvedMember[];
  readonly joints: readonly FrameJoint[];
}

export const FRAME_PROVENANCE = {
  model: 'axis_aligned_centerline_frame',
  method: '中心线长度由两端点欧氏距离得出；下料长度 = 中心线长度 − 两端让量',
  assumptions: [
    '每根杆件是轴对齐直杆，两端点只有一维坐标不同',
    '坐标按杆件中心线给出，不是外表面或槽底',
    '端部让量由调用方按实际连接件提供，默认 0 不含任何让量',
    '材料密度由调用方提供，本模块不内置材料库',
  ],
  limitations: [
    '不建模连接件、端面斜切、钻孔与铣槽',
    '不检查连接件与槽的配合，也不做干涉体积检查',
    '关节按端点坐标聚类，不推断连接方式与螺栓数量',
  ],
  disclaimer:
    '本层只输出杆件几何与长度。下料长度必须由用户按连接件与加工工艺确认；不得直接用于切割而不复核。',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      fail(`${where} 含未知字段：${key}`, `允许的字段：${allowed.join('、')}；拼写错误不会被静默忽略`, 'invalid_input');
    }
  }
}

function readFinite(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${where}.${key} 必须是有限数，收到 ${JSON.stringify(value)}`, '所有长度单位为 mm', 'invalid_input');
  }
  return value;
}

function readNonEmptyString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${where}.${key} 必须是非空字符串`, 'id 用于在 BOM 与关节清单中引用', 'invalid_input');
  }
  return value;
}

function parsePoint3(raw: unknown, where: string): Vec3 {
  if (Array.isArray(raw)) {
    if (raw.length !== 3) {
      fail(`${where} 必须是 [x, y, z] 三个数`, '三维坐标单位为 mm', 'invalid_input');
    }
    const [x, y, z] = raw;
    if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') {
      fail(`${where} 含非数值坐标`, '三维坐标必须是有限数，单位为 mm', 'invalid_input');
    }
    if (![x, y, z].every(Number.isFinite)) {
      fail(`${where} 含非有限坐标：[${x}, ${y}, ${z}]`, '三维坐标必须是有限数，单位为 mm', 'invalid_input');
    }
    return v3(x, y, z);
  }
  if (isRecord(raw)) {
    assertKnownKeys(raw, ['x', 'y', 'z'], where);
    return v3(
      readFinite(raw, 'x', where),
      readFinite(raw, 'y', where),
      readFinite(raw, 'z', where),
    );
  }
  fail(`${where} 不是三维点`, '点必须是 [x, y, z] 或 {"x":..,"y":..,"z":..}', 'invalid_input');
}

function parseMaterial(raw: unknown, where: string): MaterialSpec {
  if (!isRecord(raw)) fail(`${where} 必须是对象`, 'material 需包含 densityKgPerM3，可选 name', 'invalid_input');
  assertKnownKeys(raw, ['name', 'densityKgPerM3'], where);
  const density = readFinite(raw, 'densityKgPerM3', where);
  if (!(density > 0)) fail(`${where}.densityKgPerM3 必须大于 0`, '密度单位为 kg/m^3', 'invalid_input');
  let name: string | undefined;
  if (raw['name'] !== undefined) {
    if (typeof raw['name'] !== 'string' || raw['name'].trim().length === 0) {
      fail(`${where}.name 必须是非空字符串`, '材料名用于报告，可省略', 'invalid_input');
    }
    name = raw['name'];
  }
  return { ...(name !== undefined ? { name } : {}), densityKgPerM3: density };
}

/** 解析 agent/用户提交的框架 JSON。未知字段直接拒绝。 */
export function parseFrameInput(raw: unknown): FrameInput {
  if (!isRecord(raw)) fail('框架输入必须是 JSON 对象', '形如 {"profiles":[...],"members":[...]}', 'invalid_input');
  assertKnownKeys(raw, ['profiles', 'members'], '框架');

  const profilesRaw = raw['profiles'];
  if (!Array.isArray(profilesRaw)) fail('缺少 profiles 数组', '先定义型材，再在 members 中按 profileId 引用', 'invalid_input');
  const membersRaw = raw['members'];
  if (!Array.isArray(membersRaw)) fail('缺少 members 数组', 'members 为杆件列表', 'invalid_input');

  const profiles = profilesRaw.map((item, i): FrameProfileInput => {
    const where = `profiles[${i}]`;
    if (!isRecord(item)) fail(`${where} 必须是对象`, '需包含 id、spec，可选 material', 'invalid_input');
    assertKnownKeys(item, ['id', 'spec', 'material'], where);
    const id = readNonEmptyString(item, 'id', where);
    const spec = parseProfileSpec(item['spec']);
    const material = item['material'] === undefined ? undefined : parseMaterial(item['material'], `${where}.material`);
    return { id, spec, ...(material !== undefined ? { material } : {}) };
  });

  const members = membersRaw.map((item, i): FrameMemberInput => {
    const where = `members[${i}]`;
    if (!isRecord(item)) fail(`${where} 必须是对象`, '需包含 id、profileId、start、end', 'invalid_input');
    assertKnownKeys(item, ['id', 'profileId', 'start', 'end', 'trimStart', 'trimEnd'], where);
    const start = parsePoint3(item['start'], `${where}.start`);
    const end = parsePoint3(item['end'], `${where}.end`);
    const trimStart = item['trimStart'] === undefined ? undefined : readFinite(item, 'trimStart', where);
    const trimEnd = item['trimEnd'] === undefined ? undefined : readFinite(item, 'trimEnd', where);
    return {
      id: readNonEmptyString(item, 'id', where),
      profileId: readNonEmptyString(item, 'profileId', where),
      start,
      end,
      ...(trimStart !== undefined ? { trimStart } : {}),
      ...(trimEnd !== undefined ? { trimEnd } : {}),
    };
  });

  return { profiles, members };
}

function axisOf(start: Vec3, end: Vec3, memberId: string): Axis {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  const dz = Math.abs(end.z - start.z);
  const varying = [dx > TOL.coincide, dy > TOL.coincide, dz > TOL.coincide].filter(Boolean).length;
  if (varying === 0) {
    fail(`杆件 ${memberId} 两端点重合`, '杆件长度必须大于 0', 'degenerate_member');
  }
  if (varying > 1) {
    fail(
      `杆件 ${memberId} 不是轴对齐：Δ=(${dx.toFixed(6)}, ${dy.toFixed(6)}, ${dz.toFixed(6)}) mm`,
      '一期只支持与 x/y/z 轴平行的杆件；斜杆请拆分为轴对齐段或等待后续版本',
      'not_axis_aligned',
    );
  }
  if (dx > TOL.coincide) return 'x';
  if (dy > TOL.coincide) return 'y';
  return 'z';
}

function intervalOf(member: ResolvedMember): readonly [number, number] {
  const c = member.axis === 'x' ? 'x' : member.axis === 'y' ? 'y' : 'z';
  const a = member.start[c];
  const b = member.end[c];
  return a <= b ? [a, b] : [b, a];
}

function otherCoordinates(member: ResolvedMember): readonly [number, number] {
  if (member.axis === 'x') return [member.start.y, member.start.z];
  if (member.axis === 'y') return [member.start.x, member.start.z];
  return [member.start.x, member.start.y];
}

function checkOverlaps(members: readonly ResolvedMember[]): void {
  for (let i = 0; i < members.length; i++) {
    const a = members[i]!;
    const [a1, a2] = intervalOf(a);
    const [au, av] = otherCoordinates(a);
    for (let j = i + 1; j < members.length; j++) {
      const b = members[j]!;
      if (b.axis !== a.axis) continue;
      const [bu, bv] = otherCoordinates(b);
      if (Math.abs(au - bu) > JOINT_TOL_MM || Math.abs(av - bv) > JOINT_TOL_MM) continue;
      const [b1, b2] = intervalOf(b);
      const overlap = Math.min(a2, b2) - Math.max(a1, b1);
      if (overlap > JOINT_TOL_MM) {
        fail(
          `杆件 ${a.id} 与 ${b.id} 共线重叠 ${overlap.toFixed(3)} mm`,
          '同一轴线上的杆件只能端点相接，不能重叠；检查重复杆件或坐标',
          'overlapping_members',
        );
      }
    }
  }
}

/** 按 1e-6 mm 网格聚合同一关节的端点。 */
function clusterJoints(members: readonly ResolvedMember[]): FrameJoint[] {
  interface Cluster {
    readonly point: Vec3;
    readonly ends: JointEnd[];
  }
  const cell = JOINT_TOL_MM;
  const key = (x: number, y: number, z: number): string =>
    `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
  const buckets = new Map<string, Cluster[]>();

  const findOrCreate = (point: Vec3): Cluster => {
    const baseX = Math.round(point.x / cell);
    const baseY = Math.round(point.y / cell);
    const baseZ = Math.round(point.z / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = buckets.get(`${baseX + dx},${baseY + dy},${baseZ + dz}`);
          if (bucket === undefined) continue;
          for (const cluster of bucket) {
            if (
              Math.abs(cluster.point.x - point.x) <= cell &&
              Math.abs(cluster.point.y - point.y) <= cell &&
              Math.abs(cluster.point.z - point.z) <= cell
            ) {
              return cluster;
            }
          }
        }
      }
    }
    const created: Cluster = { point, ends: [] };
    const ownKey = key(point.x, point.y, point.z);
    const bucket = buckets.get(ownKey);
    if (bucket === undefined) buckets.set(ownKey, [created]);
    else bucket.push(created);
    return created;
  };

  for (const member of members) {
    findOrCreate(member.start).ends.push({ memberId: member.id, end: 'start' });
    findOrCreate(member.end).ends.push({ memberId: member.id, end: 'end' });
  }

  const joints: FrameJoint[] = [];
  const seen = new Set<Cluster>();
  for (const bucket of buckets.values()) {
    for (const cluster of bucket) {
      if (seen.has(cluster)) continue;
      seen.add(cluster);
      joints.push({ point: cluster.point, ends: cluster.ends, memberCount: cluster.ends.length });
    }
  }
  return joints;
}

export function buildFrame(input: FrameInput): FrameModel {
  const profileIds = new Set<string>();
  const resolvedProfiles: ResolvedProfile[] = input.profiles.map((profile) => {
    if (profileIds.has(profile.id)) {
      fail(`型材 id 重复：${profile.id}`, '每个型材 id 必须唯一', 'duplicate_id');
    }
    profileIds.add(profile.id);
    const geometry = buildProfile(profile.spec);
    const props = sectionProperties(geometry.outer, geometry.holes);
    return {
      id: profile.id,
      spec: profile.spec,
      meta: geometry.meta,
      area: props.area,
      material: profile.material ?? null,
    };
  });
  const profilesById = new Map(resolvedProfiles.map((profile) => [profile.id, profile]));

  const memberIds = new Set<string>();
  const members: ResolvedMember[] = input.members.map((member) => {
    if (memberIds.has(member.id)) {
      fail(`杆件 id 重复：${member.id}`, '每根杆件 id 必须唯一', 'duplicate_id');
    }
    memberIds.add(member.id);

    const profile = profilesById.get(member.profileId);
    if (profile === undefined) {
      fail(
        `杆件 ${member.id} 引用了未定义的型材：${member.profileId}`,
        `已定义型材：${[...profileIds].join('、')}`,
        'unknown_profile',
      );
    }

    const trimStart = member.trimStart ?? DEFAULT_TRIM;
    const trimEnd = member.trimEnd ?? DEFAULT_TRIM;
    if (!Number.isFinite(trimStart) || trimStart < 0) {
      fail(`杆件 ${member.id} 的 trimStart 必须是非负有限数`, '让量单位为 mm', 'negative_trim');
    }
    if (!Number.isFinite(trimEnd) || trimEnd < 0) {
      fail(`杆件 ${member.id} 的 trimEnd 必须是非负有限数`, '让量单位为 mm', 'negative_trim');
    }

    const axis = axisOf(member.start, member.end, member.id);
    const centerlineLength = distance3(member.start, member.end);
    const cutLength = U.mm(centerlineLength - trimStart - trimEnd);
    if (!(cutLength > TOL.coincide)) {
      fail(
        `杆件 ${member.id} 下料长度 ${cutLength.toFixed(6)} mm 不为正`,
        `中心线 ${centerlineLength.toFixed(3)} mm，让量 ${trimStart} + ${trimEnd} mm`,
        'non_positive_cut_length',
      );
    }

    const area = profile.area;
    const volume = U.mm3(area * cutLength);
    const mass = profile.material === null ? null : U.kg(volume * profile.material.densityKgPerM3 * 1e-9);

    return {
      id: member.id,
      profileId: member.profileId,
      axis,
      start: member.start,
      end: member.end,
      centerlineLength,
      trimStart: U.mm(trimStart),
      trimEnd: U.mm(trimEnd),
      cutLength,
      area,
      volume,
      mass,
    };
  });

  checkOverlaps(members);
  const joints = clusterJoints(members);
  return { profiles: resolvedProfiles, members, joints };
}
