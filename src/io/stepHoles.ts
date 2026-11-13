import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Axis, FrameModel } from '../frame/model.ts';
import type { ConnectPlan, ConnectorHole, MiterCut } from '../connect/plan.ts';
import type { ProfileSpec } from '../geom/profile.ts';
import { buildProfile } from '../geom/profile.ts';
import { alongBarMm } from './drawingLayout.ts';
import { STEP_PROVENANCE } from './step.ts';
import type { MeshSolid, StepExportOptions, StepExportResult } from './step.ts';
import { frameToStep } from './step.ts';

/**
 * `step --holes`：用 manifold-3d（Apache-2.0，WASM）做布尔，把钻孔从实体里扣掉。
 *
 * 只在需要钻孔时动态加载内核；不装/不调用时 `step` 仍走纯 TS 的平面 B-rep。
 * 结果仍是 FACETED_BREP（三角面），圆孔为 24 段折线。
 */

export const STEP_HOLES_PROVENANCE = {
  ...STEP_PROVENANCE,
  format: 'ISO 10303-21 (STEP), AP214 AUTOMOTIVE_DESIGN, FACETED_BREP (holes via manifold-3d)',
  geometry:
    '每根杆件按截面轮廓与中心孔建实体，45° 斜切用剪切平面，钻孔按 clearanceDrill 直径的圆柱布尔扣除；结果为三角网格 B-rep',
  tools: 'manifold-3d 3.5.4（Apache-2.0，WASM）；仅本命令动态加载，核心几何与 BOM 不依赖',
  assumptions: [
    ...STEP_PROVENANCE.assumptions.filter((item) => !item.startsWith('钻孔')),
    '钻孔直径取 clearanceDrillMm，缺省回退 diameterMm；圆孔以 24 段折线近似',
    '只支持通孔；检测到 depthMm 非空（盲孔）会直接报错，不静默按通孔建模',
  ],
  limitations: [
    ...STEP_PROVENANCE.limitations.filter((item) => !item.startsWith('不是可直接下料')),
    '不是可直接下料的实体验证模型：含钻孔与斜切，但没有端盖、倒角与连接件',
    '布尔结果为网格 B-rep，圆柱面是折线近似；需要解析圆柱面时再评估 OCCT',
    '文件未用第三方 CAD 内核回读验证；闭合与体积由 tests/stepHoles.test.ts 自检',
  ],
  disclaimer:
    '本文件用于三维布局与干涉参考，不是可签收的制造模型；投产前须补端盖、倒角与其余工艺特征，并由工程师确认。',
} as const;

const HOLE_SEGMENTS = 24;
/** 圆柱两端各多伸出的长度，mm：确保完全贯穿截面。 */
const HOLE_MARGIN_MM = 1;

const AXIS_INDEX: Record<Axis, 0 | 1 | 2> = { x: 0, y: 1, z: 2 };
const SECTION_AXES: Record<Axis, { readonly u: Axis; readonly v: Axis }> = {
  x: { u: 'y', v: 'z' },
  y: { u: 'x', v: 'z' },
  z: { u: 'x', v: 'y' },
} as const;
const UNIT: Record<Axis, readonly [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
} as const;

interface HoleCylinder {
  readonly axis: 'u' | 'v';
  /** 沿孔轴方向的截面内坐标（axis=v 时用 u，axis=u 时用 v）。 */
  readonly across: number;
  /** 沿杆轴、从物理 start 端起算的位置，mm。 */
  readonly alongMm: number;
  readonly radiusMm: number;
}

interface Shear {
  readonly coord: 'u' | 'v';
  readonly slope: number;
}

function shearOf(cut: MiterCut | undefined, width: number, height: number): Shear | null {
  if (cut === undefined) return null;
  const coord = cut.view === 'top' ? 'u' : 'v';
  const halfDim = (coord === 'u' ? width : height) / 2;
  if (!(halfDim > 0)) return null;
  return { coord, slope: (cut.longPointMm - cut.shortPointMm) / 2 / halfDim };
}

function holesOfMember(plan: ConnectPlan, memberId: string, cutLength: number): HoleCylinder[] {
  const out: HoleCylinder[] = [];
  for (const joint of plan.joints) {
    for (const hole of joint.holes) {
      if (hole.memberId !== memberId) continue;
      out.push(toCylinder(hole, cutLength));
    }
  }
  return out;
}

function toCylinder(hole: ConnectorHole, cutLength: number): HoleCylinder {
  if (hole.depthMm !== null) {
    throw new RangeError(
      `杆件 ${hole.memberId} 的 ${hole.face} 面孔深为 ${hole.depthMm} mm（盲孔），step --holes 只支持通孔`,
    );
  }
  const diameter = hole.clearanceDrillMm ?? hole.diameterMm;
  if (diameter === null) {
    throw new RangeError(
      `杆件 ${hole.memberId} 的 ${hole.face} 面钻孔没有可用直径（系列 ${hole.boltSeries}），无法在 STEP 中扣除`,
    );
  }
  const along = alongBarMm(hole, cutLength);
  if (along === null) {
    throw new RangeError(`杆件 ${hole.memberId} 的 ${hole.face} 面孔位无法定位，step --holes 拒绝猜测`);
  }
  if (along < 0 || along > cutLength) {
    throw new RangeError(
      `杆件 ${hole.memberId} 的 ${hole.face} 面孔位 ${along.toFixed(2)} mm 超出杆身 0..${cutLength} mm，step --holes 拒绝建模`,
    );
  }
  return {
    axis: hole.face === 'top' || hole.face === 'bottom' ? 'v' : 'u',
    across: hole.face === 'top' || hole.face === 'bottom' ? hole.localU : hole.localV,
    alongMm: along,
    radiusMm: diameter / 2,
  };
}

/** 圆柱默认沿 +Z、居中；这两个矩阵把它转到局部 +Y / +X（列主序）。 */
const Z_TO_Y: readonly number[] = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
const Z_TO_X: readonly number[] = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1];

function holeSolid(wasm: ManifoldToplevel, hole: HoleCylinder, spec: { width: number; height: number }): Manifold {
  const length = (hole.axis === 'u' ? spec.width : spec.height) + 2 * HOLE_MARGIN_MM;
  const base = wasm.Manifold.cylinder(length, hole.radiusMm, hole.radiusMm, HOLE_SEGMENTS, true);
  if (hole.axis === 'u') {
    return base.transform(Z_TO_X as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]).translate(0, hole.across, hole.alongMm);
  }
  return base.transform(Z_TO_Y as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]).translate(hole.across, 0, hole.alongMm);
}

function worldPoint(
  u: number,
  v: number,
  t: number,
  axis: Axis,
  base: readonly [number, number, number],
): [number, number, number] {
  const out: [number, number, number] = [base[0], base[1], base[2]];
  const { u: uAxis, v: vAxis } = SECTION_AXES[axis];
  out[AXIS_INDEX[uAxis]] = base[AXIS_INDEX[uAxis]] + u;
  out[AXIS_INDEX[vAxis]] = base[AXIS_INDEX[vAxis]] + v;
  out[AXIS_INDEX[axis]] = base[AXIS_INDEX[axis]] + t;
  return out;
}

function mappingSign(axis: Axis): 1 | -1 {
  const { u, v } = SECTION_AXES[axis];
  const cross = [
    UNIT[u][1] * UNIT[v][2] - UNIT[u][2] * UNIT[v][1],
    UNIT[u][2] * UNIT[v][0] - UNIT[u][0] * UNIT[v][2],
    UNIT[u][0] * UNIT[v][1] - UNIT[u][1] * UNIT[v][0],
  ] as const;
  return cross[AXIS_INDEX[axis]] > 0 ? 1 : -1;
}

interface MeshBuild {
  readonly mesh: MeshSolid;
  readonly volumeMm3: number;
  readonly removedMm3: number;
}

function buildMemberMesh(
  wasm: ManifoldToplevel,
  member: FrameModel['members'][number],
  spec: ProfileSpec,
  holes: readonly HoleCylinder[],
  miters: { readonly start?: MiterCut; readonly end?: MiterCut },
): MeshBuild {
  const profile = buildProfile(spec);
  const contours = [
    profile.outer.map((p) => [p.x, p.y] as [number, number]),
    ...profile.holes.map((hole) => hole.map((p) => [p.x, p.y] as [number, number]).reverse()),
  ];
  const crossSection = new wasm.CrossSection(contours);
  const prism = crossSection.extrude(member.cutLength);
  let solid = prism;
  for (const hole of holes) solid = solid.subtract(holeSolid(wasm, hole, spec));

  const prismVolume = prism.volume();
  const volumeMm3 = solid.volume();
  if (!(volumeMm3 > 0)) throw new RangeError(`杆件 ${member.id} 布尔后实体为空，请检查孔位与孔径`);

  const raw = solid.getMesh();
  const positions = raw.vertProperties;
  const startShear = shearOf(miters.start, spec.width, spec.height);
  const endShear = shearOf(miters.end, spec.width, spec.height);
  const axis = member.axis;
  const dir = member.end[axis] >= member.start[axis] ? 1 : -1;
  const base: [number, number, number] = [
    member.start.x + (axis === 'x' ? dir * member.trimStart : 0),
    member.start.y + (axis === 'y' ? dir * member.trimStart : 0),
    member.start.z + (axis === 'z' ? dir * member.trimStart : 0),
  ];
  const mapped = new Float32Array(positions.length);
  const length = member.cutLength;
  for (let i = 0; i < positions.length; i += 3) {
    const u = positions[i]!;
    const v = positions[i + 1]!;
    const t = positions[i + 2]!;
    const cStart = startShear === null ? 0 : startShear.coord === 'u' ? u : v;
    const cEnd = endShear === null ? 0 : endShear.coord === 'u' ? u : v;
    const warped =
      t + (startShear === null ? 0 : cStart * startShear.slope * (1 - t / length)) - (endShear === null ? 0 : cEnd * endShear.slope * (t / length));
    const world = worldPoint(u, v, warped * dir, axis, base);
    mapped[i] = world[0];
    mapped[i + 1] = world[1];
    mapped[i + 2] = world[2];
  }

  const flip = mappingSign(axis) < 0;
  let tris = raw.triVerts;
  if (flip) {
    const flipped = new Uint32Array(tris.length);
    for (let i = 0; i < tris.length; i += 3) {
      flipped[i] = tris[i]!;
      flipped[i + 1] = tris[i + 2]!;
      flipped[i + 2] = tris[i + 1]!;
    }
    tris = flipped;
  }
  return { mesh: { positions: mapped, tris }, volumeMm3, removedMm3: prismVolume - volumeMm3 };
}

export async function frameToStepWithHoles(
  model: FrameModel,
  plan: ConnectPlan,
  options: Omit<StepExportOptions, 'meshes' | 'holesModeled' | 'volumeMm3'> = {},
): Promise<StepExportResult> {
  if (model.members.length === 0) return frameToStep(model, { ...options, plan });

  const mitersByMember = new Map<string, { start?: MiterCut; end?: MiterCut }>();
  for (const joint of plan.joints) {
    for (const cut of joint.miters ?? []) {
      const bucket = mitersByMember.get(cut.memberId) ?? {};
      bucket[cut.end] = cut;
      mitersByMember.set(cut.memberId, bucket);
    }
  }

  const holesByMember = new Map<string, HoleCylinder[]>();
  let holesModeled = 0;
  for (const member of model.members) {
    const holes = holesOfMember(plan, member.id, member.cutLength);
    if (holes.length > 0) {
      holesByMember.set(member.id, holes);
      holesModeled += holes.length;
    }
  }
  if (holesByMember.size === 0) return frameToStep(model, { ...options, plan });

  let module: typeof import('manifold-3d');
  try {
    module = await import('manifold-3d');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new RangeError(`step --holes 需要 manifold-3d（Apache-2.0）：${reason}`);
  }
  const wasm = await module.default();
  wasm.setup();

  const meshes = new Map<string, MeshSolid>();
  let volume = 0;
  for (const member of model.members) {
    const profile = model.profiles.find((p) => p.id === member.profileId);
    if (profile === undefined) throw new RangeError(`杆件 ${member.id} 引用了不存在的型材 ${member.profileId}`);
    const holes = holesByMember.get(member.id);
    if (holes === undefined) {
      volume += Number(profile.area) * member.cutLength;
      continue;
    }
    const built = buildMemberMesh(wasm, member, profile.spec, holes, mitersByMember.get(member.id) ?? {});
    meshes.set(member.id, built.mesh);
    volume += built.volumeMm3;
  }

  return frameToStep(model, { ...options, plan, meshes, holesModeled, volumeMm3: volume });
}
