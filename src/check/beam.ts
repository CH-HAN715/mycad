import type { ProfileSpec } from '../geom/profile.ts';
import { buildProfile, parseProfileSpec } from '../geom/profile.ts';
import { sectionProperties } from '../geom/inertia.ts';
import { PROFILE_PRESETS } from '../geom/presets.ts';
import type { Mm, Mm2, Mm3, Mm4, MPa, N } from '../geom/units.ts';
import { U } from '../geom/units.ts';

/**
 * L6 校核层 v1：标准工况解析解（简支/悬臂的挠度与弯曲应力、中心压杆欧拉临界力）。
 *
 * 责任边界：
 * - 每个结果同时输出公式、输入、单位、保守性方向与适用范围。
 * - 弹性模量、许用应力、挠度限值、安全系数一律由用户给出且必须带来源；
 *   本模块不内置任何默认承载参数。
 * - 不做 FEM，不做结构认证，不输出任何标准符合性声明。
 */

export type BeamCase = 'ss_udl' | 'ss_point' | 'cant_point' | 'cant_udl' | 'column';

/** 线载荷 N/mm，类型层固定。 */
export type NPerMm = number & { readonly __u: 'N/mm' };
export const nPerMm = (v: number): NPerMm => v as NPerMm;

export class CheckError extends Error {
  readonly code = 'E_INPUT_CHECK';
  readonly hint: string;
  readonly reason: string;

  constructor(message: string, hint: string, reason: string) {
    super(message);
    this.name = 'CheckError';
    this.hint = hint;
    this.reason = reason;
  }
}

export interface CheckSection {
  readonly areaMm2: Mm2;
  readonly iMm4: Mm4;
  readonly wMm3: Mm3;
  /** I 与 W 对应的弯曲轴说明，报告里必须原样出现。 */
  readonly bendingNote: string;
}

export interface CheckInput {
  readonly case: BeamCase;
  readonly lengthMm: Mm;
  readonly eMpa: MPa;
  readonly eSource: string;
  readonly section: CheckSection;
  /** 集中力 N；ss_point / cant_point / column 必填。 */
  readonly pN: N | null;
  /** 均布线载荷 N/mm；ss_udl / cant_udl 必填。 */
  readonly qNPerMm: NPerMm | null;
  readonly allowableMpa: MPa;
  readonly allowableSource: string;
  /** 挠度限值：跨长比（如 250 → L/250）或绝对值 mm，二选一或都给。 */
  readonly deflectionRatioLimit: number | null;
  readonly deflectionAbsLimitMm: Mm | null;
  readonly deflectionSource: string | null;
  /** 压杆安全系数：case=column 必填，其他情况不允许给（防止双重安全系数）。 */
  readonly safetyFactor: number | null;
  /** 欧拉公式有效长度系数：case=column 必填，无默认值。 */
  readonly mu: number | null;
  readonly muSource: string | null;
}

export interface Utilization {
  readonly stress: number | null;
  readonly deflection: number | null;
  readonly buckling: number | null;
}

export interface CheckResult {
  readonly case: BeamCase;
  readonly formulas: readonly string[];
  readonly inputs: {
    readonly lengthMm: number;
    readonly eMpa: number;
    readonly eSource: string;
    readonly areaMm2: number;
    readonly iMm4: number;
    readonly wMm3: number;
    readonly bendingNote: string;
    readonly pN: number | null;
    readonly qNPerMm: number | null;
    readonly allowableMpa: number;
    readonly allowableSource: string;
  };
  readonly maxMomentNmm: number | null;
  readonly maxShearN: number | null;
  readonly bendingStressMpa: number | null;
  readonly deflectionMm: number | null;
  readonly deflectionSpanRatio: number | null;
  readonly slenderness: number | null;
  readonly radiusOfGyrationMm: number | null;
  readonly eulerCriticalN: number | null;
  readonly allowableLoadN: number | null;
  readonly limits: {
    readonly deflectionRatioLimit: number | null;
    readonly deflectionAbsLimitMm: number | null;
    readonly deflectionSource: string | null;
    readonly safetyFactor: number | null;
    readonly mu: number | null;
    readonly muSource: string | null;
  };
  readonly utilizations: Utilization;
  readonly verdict: 'pass' | 'fail' | 'incomplete';
  readonly failureReasons: readonly string[];
  readonly warnings: readonly string[];
}

const FORMULAS: Record<BeamCase, readonly string[]> = {
  ss_udl: ['δmax = 5·q·L⁴ / (384·E·I)', 'Mmax = q·L² / 8', 'Vmax = q·L / 2', 'σ = M / W'],
  ss_point: ['δmax = P·L³ / (48·E·I)（中点加载）', 'Mmax = P·L / 4', 'Vmax = P / 2', 'σ = M / W'],
  cant_point: ['δmax = P·L³ / (3·E·I)（自由端加载）', 'Mmax = P·L', 'Vmax = P', 'σ = M / W'],
  cant_udl: ['δmax = q·L⁴ / (8·E·I)', 'Mmax = q·L² / 2', 'Vmax = q·L', 'σ = M / W'],
  column: ['Pcr = π²·E·I / (μ·L)²（欧拉临界力，μ 为有效长度系数：两端铰接 μ=1，两端固定 μ=0.5）', 'λ = L / i，i = √(I / A)'],
} as const;

export const CHECK_PROVENANCE = {
  model: 'standard_case_analytical_v1',
  method: '欧拉-伯努利直梁小挠度弹性解析解；只覆盖五种标准工况，不求解一般载荷',
  formulas: FORMULAS,
  applicability: [
    '等截面直杆、线弹性材料（σ 不超过比例极限）、小挠度（δ<≈L/50）',
    '载荷作用在通过弯心且与截面惯性主轴平行的平面内；本层不校验 Ixy≠0 的斜弯曲',
    '开口薄壁型材的扭转、剪力变形、局部屈曲均未建模',
    '欧拉公式只适用于弹性范围的大柔度压杆；中低柔度需要实验折减系数，本层没有',
  ],
  conservatism: [
    '挠度公式给出的是标准加载位置的最大值：加载点位置不确定时按中点/自由端取，偏不利（保守）',
    '弯曲应力按弹性极端纤维 σ=M/W，不考虑塑性发展（保守）',
    '欧拉临界力忽略初弯曲、偏心与残余应力，实际稳定承载力低于该值：非保守，必须配合安全系数使用',
    '锯缝、连接件让量与孔眼削弱截面不在本层计入；有孔部位需用净截面 W 另行复核',
  ],
  disclaimer:
    '本层输出是工程校核的参考值，不构成结构认证或规范符合性声明；承载设计必须由具备资质的工程师复核。',
} as const;

function requirePositive(value: number | null, what: string, hint: string): number {
  if (value === null || !Number.isFinite(value) || !(value > 0)) {
    throw new CheckError(`${what} 必须为正的有限数，收到 ${JSON.stringify(value)}`, hint, 'invalid_input');
  }
  return value;
}

export function runCheck(input: CheckInput): CheckResult {
  const length = requirePositive(input.lengthMm as number, 'lengthMm', '杆长单位 mm');
  const e = requirePositive(input.eMpa as number, 'eMpa', '弹性模量单位 MPa（=N/mm²）；来源必须标注');
  if (input.eSource.trim().length === 0) {
    throw new CheckError('eSource 不能为空', '默认参数不得静默生效：写清弹性模量出处，如材料牌号与数据来源', 'missing_source');
  }
  const area = requirePositive(input.section.areaMm2 as number, 'section.areaMm2', '面积单位 mm²');
  const i = requirePositive(input.section.iMm4 as number, 'section.iMm4', '惯性矩单位 mm⁴，取载荷弯曲轴方向');
  const w = requirePositive(input.section.wMm3 as number, 'section.wMm3', '截面模量单位 mm³，与 iMm4 同轴');
  const allowable = requirePositive(input.allowableMpa as number, 'allowableMpa', '许用弯曲应力单位 MPa');
  if (input.allowableSource.trim().length === 0) {
    throw new CheckError('allowableSource 不能为空', '许用应力来源必须标注；无来源就写「工程惯例，非规范条文」并自行承担保守性', 'missing_source');
  }

  const warnings: string[] = [];
  const failures: string[] = [];
  const { case: beamCase } = input;

  let p: number | null = null;
  let q: number | null = null;
  if (beamCase === 'ss_point' || beamCase === 'cant_point' || beamCase === 'column') {
    p = requirePositive(input.pN as number | null, 'pN（本工况需要集中力）', 'ss_point / cant_point / column 用 pN，单位 N');
    if (input.qNPerMm !== null) warnings.push('本工况不使用 qNPerMm，已忽略');
  } else {
    q = requirePositive(input.qNPerMm as number | null, 'qNPerMm（本工况需要均布载荷）', 'ss_udl / cant_udl 用 qNPerMm，单位 N/mm');
    if (input.pN !== null) warnings.push('本工况不使用 pN，已忽略');
  }

  if (beamCase === 'column') {
    if (input.safetyFactor === null) {
      throw new CheckError('column 工况必须给 safetyFactor', '欧拉临界力是非保守值，必须带安全系数；来源写进 muSource/文件', 'missing_safety_factor');
    }
    requirePositive(input.safetyFactor, 'safetyFactor', '安全系数必须大于 0，且必须标注来源');
    if (input.mu === null) {
      throw new CheckError('column 工况必须给 mu（有效长度系数）', '常见约束组合的 μ 属工程惯例取值，必须由使用者确认边界条件后给出，本层不设默认', 'missing_mu');
    }
    requirePositive(input.mu, 'mu', 'μ>0；两端铰接取 1');
    if (input.muSource === null || input.muSource.trim().length === 0) {
      throw new CheckError('column 工况必须给 muSource', 'μ 对应哪组边界条件必须写明出处', 'missing_source');
    }
  } else if (input.safetyFactor !== null) {
    warnings.push('梁工况给了 safetyFactor：许用应力通常已含安全储备，避免双重安全系数；本结果未使用它');
  }

  if (input.deflectionRatioLimit === null && input.deflectionAbsLimitMm === null && beamCase !== 'column') {
    warnings.push('未给挠度限值：只核应力不核刚度，结果标记 incomplete');
  }
  if ((input.deflectionRatioLimit !== null || input.deflectionAbsLimitMm !== null) && (input.deflectionSource === null || input.deflectionSource.trim().length === 0)) {
    throw new CheckError('给了挠度限值却没给 deflectionSource', '限值来源必须标注；工程惯例请写「工程惯例，非规范条文」', 'missing_source');
  }

  const EI = e * i;
  let moment: number | null = null;
  let shear: number | null = null;
  let deflection: number | null = null;
  let euler: number | null = null;
  let radius = null as number | null;
  let slenderness = null as number | null;
  let allowableLoad: number | null = null;

  switch (beamCase) {
    case 'ss_udl':
      deflection = (5 * q! * length ** 4) / (384 * EI);
      moment = (q! * length * length) / 8;
      shear = (q! * length) / 2;
      break;
    case 'ss_point':
      deflection = (p! * length ** 3) / (48 * EI);
      moment = (p! * length) / 4;
      shear = p! / 2;
      break;
    case 'cant_point':
      deflection = (p! * length ** 3) / (3 * EI);
      moment = p! * length;
      shear = p!;
      break;
    case 'cant_udl':
      deflection = (q! * length ** 4) / (8 * EI);
      moment = (q! * length * length) / 2;
      shear = q! * length;
      break;
    case 'column': {
      const mu = input.mu!;
      euler = (Math.PI * Math.PI * EI) / (mu * length * (mu * length));
      radius = Math.sqrt(i / area);
      slenderness = length / radius;
      allowableLoad = euler / input.safetyFactor!;
      if (p! > allowableLoad) failures.push(`压力 ${p} N 超过许用值 ${allowableLoad.toFixed(1)} N（Pcr=${euler.toFixed(1)} N，SF=${input.safetyFactor}）`);
      if (slenderness < 60) {
        warnings.push(`柔度 λ=${slenderness.toFixed(1)} < 60：欧拉公式适用范围存疑（低柔度失稳承载力通常更低），需实测或改用经验公式`);
      }
      break;
    }
  }

  const stress = moment === null ? null : moment / w;
  if (stress !== null && stress > allowable) {
    failures.push(`弯曲应力 ${stress.toFixed(3)} MPa 超过许用值 ${allowable} MPa`);
  }
  if (deflection !== null && moment !== null) {
    // 悬臂的跨度比按同长度简支类比给参考值，挠度本身按公式取最大值
    const spanRatio = deflection / length;
    if (spanRatio > 1 / 50) warnings.push(`挠度比 1/${(1 / spanRatio).toFixed(0)} 超出小挠度理论常用的 1/50 界限，解析解精度存疑`);
  }

  let deflectionUtil: number | null = null;
  if (deflection !== null) {
    const candidates: number[] = [];
    if (input.deflectionRatioLimit !== null) {
      const limit = length / input.deflectionRatioLimit;
      candidates.push(deflection / limit);
    }
    if (input.deflectionAbsLimitMm !== null) candidates.push(deflection / (input.deflectionAbsLimitMm as number));
    if (candidates.length > 0) {
      deflectionUtil = Math.max(...candidates);
      if (deflectionUtil > 1) failures.push(`挠度 ${deflection.toFixed(3)} mm 超过限值（利用率 ${deflectionUtil.toFixed(3)}）`);
    }
  }

  const stressUtil = stress === null ? null : stress / allowable;
  const bucklingUtil = beamCase === 'column' ? p! / allowableLoad! : null;
  const utilizations: Utilization = { stress: stressUtil, deflection: deflectionUtil, buckling: bucklingUtil };

  // 校核完整性：压杆的稳定校核必然执行（SF/μ 强制输入）；梁的应力必查、挠度按是否给限值判断
  const checksComplete = beamCase === 'column' || input.deflectionRatioLimit !== null || input.deflectionAbsLimitMm !== null;
  const verdict: CheckResult['verdict'] = failures.length > 0 ? 'fail' : checksComplete ? 'pass' : 'incomplete';

  return {
    case: beamCase,
    formulas: FORMULAS[beamCase],
    inputs: {
      lengthMm: length,
      eMpa: e,
      eSource: input.eSource,
      areaMm2: area,
      iMm4: i,
      wMm3: w,
      bendingNote: input.section.bendingNote,
      pN: p,
      qNPerMm: q,
      allowableMpa: allowable,
      allowableSource: input.allowableSource,
    },
    maxMomentNmm: moment,
    maxShearN: shear,
    bendingStressMpa: stress,
    deflectionMm: deflection,
    deflectionSpanRatio: deflection === null ? null : deflection / length,
    slenderness,
    radiusOfGyrationMm: radius,
    eulerCriticalN: euler,
    allowableLoadN: allowableLoad,
    limits: {
      deflectionRatioLimit: input.deflectionRatioLimit,
      deflectionAbsLimitMm: input.deflectionAbsLimitMm,
      deflectionSource: input.deflectionSource,
      safetyFactor: input.safetyFactor,
      mu: input.mu,
      muSource: input.muSource,
    },
    utilizations,
    verdict,
    failureReasons: failures,
    warnings,
  };
}

/** 由参数化截面直接取校核需要的 A/I/W（保守取双边缘模量的较小者）。 */
/** 按 spec 精确匹配内置预设；命中且带厂家公布值时返回保守截面值。 */
function publishedSectionOf(
  spec: ProfileSpec,
  axis: 'x' | 'y',
): { readonly iMm4: number; readonly wMm3: number; readonly areaMm2: number; readonly sourceTitle: string } | null {
  for (const preset of PROFILE_PRESETS) {
    const ref = preset.reference;
    if (ref === undefined || ref.ixMm4 === undefined || ref.zxMm3 === undefined) continue;
    const a = preset.spec;
    const sameSlot =
      (a.slot === undefined) === (spec.slot === undefined) &&
      (a.slot === undefined ||
        (a.slot.opening === spec.slot?.opening &&
          a.slot.depth === spec.slot?.depth &&
          a.slot.headWidth === spec.slot?.headWidth &&
          a.slot.headStart === spec.slot?.headStart));
    const sameBore =
      (a.bore === undefined) === (spec.bore === undefined) &&
      (a.bore === undefined || a.bore.radius === spec.bore?.radius);
    if (a.width !== spec.width || a.height !== spec.height || !sameSlot || !sameBore) continue;
    return {
      iMm4: axis === 'x' ? ref.ixMm4 : ref.iyMm4 ?? ref.ixMm4,
      wMm3: axis === 'x' ? ref.zxMm3 : ref.zyMm3 ?? ref.zxMm3,
      areaMm2: ref.massPerMeterKg === undefined ? Number.POSITIVE_INFINITY : (ref.massPerMeterKg / 2.7e-3),
      sourceTitle: `${ref.sourceTitle}（核对 ${ref.checkedAt}）`,
    };
  }
  return null;
}

export function sectionFromProfile(spec: ProfileSpec, axis: 'x' | 'y', slotRole?: string): CheckSection {
  const geometry = buildProfile(spec);
  const props = sectionProperties(geometry.outer, geometry.holes);
  const published = publishedSectionOf(spec, axis);
  if (published !== null) {
    // 直角理想化不含内腔，大截面算出的 I 会显著偏大（偏乐观）；有厂家公布值时取两者较小值。
    const iMm4 = Math.min(axis === 'x' ? props.ix : props.iy, published.iMm4);
    const wMm3 = Math.min(
      axis === 'x'
        ? U.mm3(Math.min(props.modulus.wxTop, props.modulus.wxBottom))
        : U.mm3(Math.min(props.modulus.wyLeft, props.modulus.wyRight)),
      published.wMm3,
    );
    return {
      areaMm2: U.mm2(Math.min(props.area, published.areaMm2)),
      iMm4: U.mm4(iMm4),
      wMm3: U.mm3(wMm3),
      bendingNote:
        `绕 ${axis} 轴弯曲：A/I/W 取「理想化计算值」与「厂家公布值」的较小者（保守方向）；` +
        `计算值 I=${(axis === 'x' ? props.ix : props.iy).toFixed(0)}mm⁴，公布值 I=${published.iMm4}mm⁴；来源：${published.sourceTitle}`,
    };
  }
  if (axis === 'x') {
    return {
      areaMm2: props.area,
      iMm4: props.ix,
      wMm3: U.mm3(Math.min(props.modulus.wxTop, props.modulus.wxBottom)),
      bendingNote: `绕 x 轴（局部 u 方向）弯曲：I=Ix，W=min(Wx上, Wx下)${slotRole ? `；${slotRole}` : ''}`,
    };
  }
  return {
    areaMm2: props.area,
    iMm4: props.iy,
    wMm3: U.mm3(Math.min(props.modulus.wyLeft, props.modulus.wyRight)),
    bendingNote: `绕 y 轴（局部 v 方向）弯曲：I=Iy，W=min(Wy左, Wy右)${slotRole ? `；${slotRole}` : ''}`,
  };
}

const BEAM_CASES: readonly BeamCase[] = ['ss_udl', 'ss_point', 'cant_point', 'cant_udl', 'column'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const v = record[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CheckError(`${key} 必须是有限数或 null`, '数值单位见 UNIT_SCHEMA', 'invalid_input');
  return v;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const v = record[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new CheckError(`${key} 必须是字符串或 null`, '来源标注用于防止默认参数静默生效', 'invalid_input');
  return v;
}

/**
 * 解析校核输入 JSON。两种给截面的方式：
 * - "section": {"areaMm2":…,"iMm4":…,"wMm3":…,"bendingNote":…}
 * - "profile": <截面 DSL>，"bendingAxis": "x"|"y"（由 L2 自算 A/I/W）
 */
export function parseCheckInput(raw: unknown): CheckInput {
  if (!isRecord(raw)) throw new CheckError('校核输入必须是 JSON 对象', '形如 {"case":"ss_udl","lengthMm":600,...}', 'invalid_input');
  const allowed = ['case', 'lengthMm', 'eMpa', 'eSource', 'section', 'profile', 'bendingAxis', 'pN', 'qNPerMm', 'allowableMpa', 'allowableSource', 'deflectionRatioLimit', 'deflectionAbsLimitMm', 'deflectionSource', 'safetyFactor', 'mu', 'muSource'];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) throw new CheckError(`校核输入含未知字段：${key}`, `允许：${allowed.join('、')}`, 'invalid_input');
  }
  const beamCase = raw['case'];
  if (typeof beamCase !== 'string' || !BEAM_CASES.includes(beamCase as BeamCase)) {
    throw new CheckError(`case 非法：${String(beamCase)}`, `可用：${BEAM_CASES.join('、')}（简支均布 / 简支中点 / 悬臂端载 / 悬臂均布 / 中心压杆）`, 'invalid_input');
  }

  let section: CheckSection;
  const hasSection = raw['section'] !== undefined;
  const hasProfile = raw['profile'] !== undefined;
  if (hasSection === hasProfile) {
    throw new CheckError('section 与 profile 必须二选一', '直接给 {"section":{...}}，或给 {"profile":{...},"bendingAxis":"x"} 由截面特性自算', 'invalid_input');
  }
  if (hasSection) {
    if (!isRecord(raw['section'])) throw new CheckError('section 必须是对象', '需 areaMm2、iMm4、wMm3、bendingNote', 'invalid_input');
    const s = raw['section'];
    for (const key of Object.keys(s)) {
      if (!['areaMm2', 'iMm4', 'wMm3', 'bendingNote'].includes(key)) throw new CheckError(`section 含未知字段：${key}`, '允许：areaMm2、iMm4、wMm3、bendingNote', 'invalid_input');
    }
    const bendingNote = s['bendingNote'];
    section = {
      areaMm2: U.mm2(requirePositive(optionalNumber(s, 'areaMm2'), 'section.areaMm2', 'mm²') as number),
      iMm4: U.mm4(requirePositive(optionalNumber(s, 'iMm4'), 'section.iMm4', 'mm⁴') as number),
      wMm3: U.mm3(requirePositive(optionalNumber(s, 'wMm3'), 'section.wMm3', 'mm³') as number),
      bendingNote: typeof bendingNote === 'string' && bendingNote.trim().length > 0 ? bendingNote : '用户直接给定 I/W，弯曲轴由用户负责确认',
    };
  } else {
    const spec = parseProfileSpec(raw['profile']);
    const axis = raw['bendingAxis'] ?? 'x';
    if (axis !== 'x' && axis !== 'y') throw new CheckError('bendingAxis 只能是 "x" 或 "y"', '对应截面局部坐标轴', 'invalid_input');
    section = sectionFromProfile(spec, axis, 'A/I/W 由 L2 参数化截面自算');
  }

  return {
    case: beamCase as BeamCase,
    lengthMm: U.mm(requirePositive(optionalNumber(raw, 'lengthMm'), 'lengthMm', 'mm') as number),
    eMpa: U.mpa(requirePositive(optionalNumber(raw, 'eMpa'), 'eMpa', 'MPa') as number),
    eSource: (optionalString(raw, 'eSource') ?? (() => {
      throw new CheckError('eSource 必填', '弹性模量来源必须标注', 'missing_source');
    })()),
    section,
    pN: optionalNumber(raw, 'pN') === null ? null : (U.n(optionalNumber(raw, 'pN')!) as N),
    qNPerMm: optionalNumber(raw, 'qNPerMm') === null ? null : nPerMm(optionalNumber(raw, 'qNPerMm')!),
    allowableMpa: U.mpa(requirePositive(optionalNumber(raw, 'allowableMpa'), 'allowableMpa', 'MPa') as number),
    allowableSource: (optionalString(raw, 'allowableSource') ?? (() => {
      throw new CheckError('allowableSource 必填', '许用应力来源必须标注', 'missing_source');
    })()),
    deflectionRatioLimit: optionalNumber(raw, 'deflectionRatioLimit'),
    deflectionAbsLimitMm: optionalNumber(raw, 'deflectionAbsLimitMm') === null ? null : U.mm(optionalNumber(raw, 'deflectionAbsLimitMm')!),
    deflectionSource: optionalString(raw, 'deflectionSource'),
    safetyFactor: optionalNumber(raw, 'safetyFactor'),
    mu: optionalNumber(raw, 'mu'),
    muSource: optionalString(raw, 'muSource'),
  };
}
