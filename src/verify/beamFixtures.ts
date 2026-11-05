import type { CheckInput } from '../check/beam.ts';
import { nPerMm, runCheck } from '../check/beam.ts';
import { U } from '../geom/units.ts';
import { TOL } from '../geom/tolerance.ts';

/**
 * L6 校核的手算对照算例库（AGENTS.md 十一.5）。
 * 期望值由独立算式（分数/闭式）推出，推导行可手算复核；
 * 实测列来自 runCheck 的输出，两边不共享实现。
 */

export interface BeamExpectation {
  readonly deflectionMm?: number;
  readonly maxMomentNmm?: number;
  readonly maxShearN?: number;
  readonly bendingStressMpa?: number;
  readonly eulerCriticalN?: number;
  readonly slenderness?: number;
  readonly allowableLoadN?: number;
  readonly verdict: 'pass' | 'fail' | 'incomplete';
}

export interface BeamVerifyCase {
  readonly id: string;
  readonly title: string;
  readonly input: CheckInput;
  readonly expect: BeamExpectation;
  readonly derivation: readonly string[];
}

const num = (v: number | null): number => v ?? Number.NaN;

const mkInput = (
  base: {
    case: CheckInput['case'];
    lengthMm: number;
    iMm4: number;
    areaMm2?: number;
    wMm3?: number;
    pN?: number;
    qNPerMm?: number;
    allowableMpa?: number;
    deflectionRatioLimit?: number;
    safetyFactor?: number;
    mu?: number;
  },
): CheckInput => ({
  case: base.case,
  lengthMm: U.mm(base.lengthMm),
  eMpa: U.mpa(70000),
  eSource: '6xxx-T5 铝合金弹性模量近似 70 GPa：工程惯例，非规范条文（需按材料牌号实测）',
  section: {
    areaMm2: U.mm2(base.areaMm2 ?? 2500),
    iMm4: U.mm4(base.iMm4),
    wMm3: U.mm3(base.wMm3 ?? 5e4),
    bendingNote: '算例直接给定 I/W，弯曲轴由调用方约定',
  },
  pN: base.pN === undefined ? null : U.n(base.pN),
  qNPerMm: base.qNPerMm === undefined ? null : nPerMm(base.qNPerMm),
  allowableMpa: U.mpa(base.allowableMpa ?? 80),
  allowableSource: '算例假设值：工程惯例，非规范条文',
  deflectionRatioLimit: base.deflectionRatioLimit ?? null,
  deflectionAbsLimitMm: null,
  deflectionSource: base.deflectionRatioLimit === undefined ? null : '算例假设 L/250：工程惯例，非规范条文',
  safetyFactor: base.safetyFactor ?? null,
  mu: base.mu ?? null,
  muSource: base.mu === undefined ? null : '两端铰接 μ=1：材料力学标准情形',
});

export const BEAM_VERIFY_CASES: readonly BeamVerifyCase[] = [
  {
    id: 'check-ss-udl-1000',
    title: '简支均布：L=1000，q=10 N/mm，I=1e6，W=5e4（许用 20 → 应力不通过）',
    input: {
      ...mkInput({ case: 'ss_udl', lengthMm: 1000, iMm4: 1e6, qNPerMm: 10, deflectionRatioLimit: 250 }),
      allowableMpa: U.mpa(20),
    },
    expect: {
      deflectionMm: 1.8601190476190477,
      maxMomentNmm: 1_250_000,
      maxShearN: 5000,
      bendingStressMpa: 25,
      verdict: 'fail',
    },
    derivation: [
      'δ = 5qL⁴/(384EI) = 5·10·1000⁴ / (384·70000·10⁶) = 5·10¹³/2.688·10¹³ = 1.86011905 mm',
      'M = qL²/8 = 10·10⁶/8 = 1.25·10⁶ N·mm',
      'σ = M/W = 1.25·10⁶/5·10⁴ = 25 MPa > 20 MPa → 应力超限',
      '挠度限值 L/250 = 4 mm，δ/limit = 0.465 → 挠度通过；综合 verdict = fail',
    ],
  },
  {
    id: 'check-ss-point-800',
    title: '简支中点：L=800，P=1000 N，I=2e6，W=1e4',
    input: mkInput({ case: 'ss_point', lengthMm: 800, iMm4: 2e6, wMm3: 1e4, pN: 1000, deflectionRatioLimit: 250 }),
    expect: {
      deflectionMm: 0.0761904761904762,
      maxMomentNmm: 200_000,
      maxShearN: 500,
      bendingStressMpa: 20,
      verdict: 'pass',
    },
    derivation: [
      'δ = PL³/(48EI) = 1000·800³/(48·70000·2·10⁶) = 5.12·10¹¹/6.72·10¹² = 0.07619048 mm',
      'M = PL/4 = 1000·800/4 = 2·10⁵ N·mm',
      'σ = 2·10⁵/10⁴ = 20 MPa ≤ 80 → 通过',
      '限值 L/250 = 3.2 mm，利用率 0.0238 → 通过',
    ],
  },
  {
    id: 'check-cant-point-600',
    title: '悬臂端载：L=600，P=500 N，I=1e6，W=5e4',
    input: mkInput({ case: 'cant_point', lengthMm: 600, iMm4: 1e6, pN: 500, deflectionRatioLimit: 250 }),
    expect: {
      deflectionMm: 0.5142857142857142,
      maxMomentNmm: 300_000,
      maxShearN: 500,
      bendingStressMpa: 6,
      verdict: 'pass',
    },
    derivation: [
      'δ = PL³/(3EI) = 500·600³/(3·70000·10⁶) = 1.08·10¹¹/2.1·10¹¹ = 0.51428571 mm',
      'M = PL = 500·600 = 3·10⁵ N·mm；σ = 3·10⁵/5·10⁴ = 6 MPa',
      'V = P = 500 N',
    ],
  },
  {
    id: 'check-cant-udl-400',
    title: '悬臂均布：L=400，q=5 N/mm，I=1e6，W=5e4',
    input: mkInput({ case: 'cant_udl', lengthMm: 400, iMm4: 1e6, qNPerMm: 5, deflectionRatioLimit: 250 }),
    expect: {
      deflectionMm: 0.22857142857142856,
      maxMomentNmm: 400_000,
      maxShearN: 2000,
      bendingStressMpa: 8,
      verdict: 'pass',
    },
    derivation: [
      'δ = qL⁴/(8EI) = 5·400⁴/(8·70000·10⁶) = 1.28·10¹¹/5.6·10¹¹ = 0.22857143 mm',
      'M = qL²/2 = 5·160000/2 = 4·10⁵ N·mm；σ = 8 MPa',
      'V = qL = 5·400 = 2000 N',
    ],
  },
  {
    id: 'check-column-euler-1500',
    title: '中心压杆：L=1500，I=5e5，A=2500，μ=1，SF=3，P=4e4 N',
    input: mkInput({ case: 'column', lengthMm: 1500, iMm4: 5e5, pN: 40000, safetyFactor: 3, mu: 1 }),
    expect: {
      eulerCriticalN: 153527.1795725011,
      slenderness: 106.06601717798212,
      allowableLoadN: 51175.72652416703,
      verdict: 'pass',
    },
    derivation: [
      'i = √(I/A) = √(5·10⁵/2500) = √200 = 14.14213562 mm',
      'λ = L/i = 1500/14.14213562 = 106.0660172（>60，欧拉公式适用性成立）',
      'Pcr = π²EI/L² = π²·70000·5·10⁵/1500² = π²·3.5·10¹⁰/2.25·10⁶ = 153527.18 N',
      '许用 = Pcr/SF = 153527.18/3 = 51175.73 N > P = 40000 → 通过',
    ],
  },
];

export interface BeamComparison {
  readonly deviations: readonly string[];
  readonly maxRelError: number;
  readonly ok: boolean;
}

/** 与 VERIFY_CASES 同一判定口径：相对误差 ≤ TOL.relVerify（期望为 0 用绝对误差）。 */
export function compareBeamCase(actual: ReturnType<typeof runCheck>, expect: BeamExpectation, relTol: number = TOL.relVerify): BeamComparison {
  const pairs: readonly (readonly [string, number | undefined, number | undefined])[] = [
    ['deflectionMm', expect.deflectionMm, actual.deflectionMm === null ? undefined : num(actual.deflectionMm)],
    ['maxMomentNmm', expect.maxMomentNmm, actual.maxMomentNmm === null ? undefined : num(actual.maxMomentNmm)],
    ['maxShearN', expect.maxShearN, actual.maxShearN === null ? undefined : num(actual.maxShearN)],
    ['bendingStressMpa', expect.bendingStressMpa, actual.bendingStressMpa === null ? undefined : num(actual.bendingStressMpa)],
    ['eulerCriticalN', expect.eulerCriticalN, actual.eulerCriticalN === null ? undefined : num(actual.eulerCriticalN)],
    ['slenderness', expect.slenderness, actual.slenderness === null ? undefined : num(actual.slenderness)],
    ['allowableLoadN', expect.allowableLoadN, actual.allowableLoadN === null ? undefined : num(actual.allowableLoadN)],
  ];
  const deviations: string[] = [];
  let maxRelError = 0;
  for (const [field, want, got] of pairs) {
    if (want === undefined) continue;
    if (got === undefined || !Number.isFinite(got)) {
      deviations.push(`${field}：算例期望 ${want}，实测缺失`);
      continue;
    }
    const rel = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
    if (rel > maxRelError) maxRelError = rel;
    if (!(rel <= relTol)) deviations.push(`${field}：期望 ${want}，实测 ${got}（相对误差 ${rel.toExponential(2)}）`);
  }
  if (actual.verdict !== expect.verdict) deviations.push(`verdict：期望 ${expect.verdict}，实测 ${actual.verdict}`);
  return { deviations, maxRelError, ok: deviations.length === 0 };
}
