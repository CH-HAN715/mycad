import type { FrameModel } from '../frame/model.ts';
import { FRAME_PROVENANCE } from '../frame/model.ts';
import type { CutOptions, CutPlan } from './cutPlan.ts';
import { CUT_PROVENANCE, planCuts } from './cutPlan.ts';

/**
 * L5 BOM：把已求解的框架汇总成型材清单与下料清单。
 *
 * 分组精度 0.001 mm（1 μm），远低于任何加工公差；原始值仍保留在 FrameModel 中。
 * 质量只在材料密度齐全时输出，缺密度时明确标 null，不猜。
 */

const GROUP_DECIMALS = 3;
const GROUP_SCALE = 10 ** GROUP_DECIMALS;

export const BOM_PROVENANCE = {
  method: '按型材 id 与下料长度分组；长度来自 L4 中心线减让量，质量由截面面积×长度×密度得出',
  groupingToleranceMm: 1 / GROUP_SCALE,
  assumptions: [
    '下料长度 = 中心线长度 − 两端让量，让量由调用方按连接件提供',
    '同一型材 id 与同一长度（0.001 mm 内）视为同一种下料',
    '质量只在型材材料密度齐全时输出',
  ],
  limitations: [
    '不含连接件、螺栓、螺母、端盖等外购件清单',
    '不含表面处理、包装、运输与损耗率',
    '分组会按 0.001 mm 取整，原始长度见 frame 输出',
  ],
  disclaimer: 'BOM 为几何汇总结果，不包含采购损耗与连接件选型；下单前必须人工复核。',
} as const;

export interface BomCutItem {
  readonly profileId: string;
  readonly lengthMm: number;
  readonly quantity: number;
  readonly pieceLengthTotalMm: number;
}

export interface BomProfileSummary {
  readonly profileId: string;
  readonly memberCount: number;
  readonly areaMm2: number;
  readonly totalCutLengthMm: number;
  readonly totalVolumeMm3: number;
  readonly totalMassKg: number | null;
  readonly materialName: string | null;
  readonly densityKgPerM3: number | null;
}

export interface Bom {
  readonly cutList: readonly BomCutItem[];
  readonly profiles: readonly BomProfileSummary[];
  readonly stockPlan: CutPlan | null;
  readonly totalMembers: number;
  readonly totalCutLengthMm: number;
  readonly totalVolumeMm3: number;
  readonly totalMassKg: number | null;
  readonly missingMaterialFor: readonly string[];
  readonly frame: typeof FRAME_PROVENANCE;
  readonly cut: typeof CUT_PROVENANCE | null;
  readonly provenance: typeof BOM_PROVENANCE;
}

function roundLength(length: number): number {
  return Math.round(length * GROUP_SCALE) / GROUP_SCALE;
}

export function buildBom(model: FrameModel, cutOptions?: CutOptions): Bom {
  const profilesById = new Map(model.profiles.map((profile) => [profile.id, profile]));

  const profileStats = new Map<
    string,
    { memberCount: number; totalCutLengthMm: number; totalVolumeMm3: number; massKg: number; massComplete: boolean }
  >();
  let totalCutLength = 0;
  let totalVolume = 0;

  for (const member of model.members) {
    const stat = profileStats.get(member.profileId) ?? {
      memberCount: 0,
      totalCutLengthMm: 0,
      totalVolumeMm3: 0,
      massKg: 0,
      massComplete: true,
    };
    stat.memberCount += 1;
    stat.totalCutLengthMm += member.cutLength;
    stat.totalVolumeMm3 += member.volume;
    if (member.mass === null) stat.massComplete = false;
    else stat.massKg += member.mass;
    profileStats.set(member.profileId, stat);
    totalCutLength += member.cutLength;
    totalVolume += member.volume;
  }

  const missingMaterialFor: string[] = [];
  const profileSummaries: BomProfileSummary[] = model.profiles.map((profile) => {
    const stat = profileStats.get(profile.id);
    if (stat === undefined) {
      return {
        profileId: profile.id,
        memberCount: 0,
        areaMm2: profile.area,
        totalCutLengthMm: 0,
        totalVolumeMm3: 0,
        totalMassKg: null,
        materialName: profile.material?.name ?? null,
        densityKgPerM3: profile.material?.densityKgPerM3 ?? null,
      };
    }
    if (!stat.massComplete) missingMaterialFor.push(profile.id);
    return {
      profileId: profile.id,
      memberCount: stat.memberCount,
      areaMm2: profile.area,
      totalCutLengthMm: stat.totalCutLengthMm,
      totalVolumeMm3: stat.totalVolumeMm3,
      totalMassKg: stat.massComplete ? stat.massKg : null,
      materialName: profile.material?.name ?? null,
      densityKgPerM3: profile.material?.densityKgPerM3 ?? null,
    };
  });

  const groups = new Map<string, { profileId: string; lengthMm: number; quantity: number }>();
  for (const member of model.members) {
    const length = roundLength(member.cutLength);
    const key = `${member.profileId}\u0000${length}`;
    const group = groups.get(key) ?? { profileId: member.profileId, lengthMm: length, quantity: 0 };
    group.quantity += 1;
    groups.set(key, group);
  }
  const cutList: BomCutItem[] = [...groups.values()]
    .map((group) => ({
      profileId: group.profileId,
      lengthMm: group.lengthMm,
      quantity: group.quantity,
      pieceLengthTotalMm: group.lengthMm * group.quantity,
    }))
    .sort((a, b) => a.profileId.localeCompare(b.profileId) || b.lengthMm - a.lengthMm);

  const stockPlan =
    cutOptions === undefined
      ? null
      : planCuts(
          cutList.map((item) => ({ id: `${item.profileId}@${item.lengthMm}`, lengthMm: item.lengthMm, quantity: item.quantity })),
          cutOptions,
        );

  const massComplete = missingMaterialFor.length === 0 && profileStats.size > 0;
  const totalMass = massComplete
    ? profileSummaries.reduce((sum, profile) => sum + (profile.totalMassKg ?? 0), 0)
    : null;

  return {
    cutList,
    profiles: profileSummaries,
    stockPlan,
    totalMembers: model.members.length,
    totalCutLengthMm: totalCutLength,
    totalVolumeMm3: totalVolume,
    totalMassKg: totalMass,
    missingMaterialFor,
    frame: FRAME_PROVENANCE,
    cut: stockPlan === null ? null : CUT_PROVENANCE,
    provenance: BOM_PROVENANCE,
  };
}

/** 供 CLI/报告使用的截面面积查询（型材 id → mm^2）。 */
export function profileAreas(model: FrameModel): ReadonlyMap<string, number> {
  return new Map(model.profiles.map((profile) => [profile.id, profile.area]));
}
