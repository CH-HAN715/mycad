import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CheckError, parseCheckInput, runCheck, sectionFromProfile } from '../src/check/beam.ts';
import { U } from '../src/geom/units.ts';
import { SYN_2020_SPEC } from '../src/verify/fixtures.ts';
import { findProfilePreset } from '../src/geom/presets.ts';
import { BEAM_VERIFY_CASES, compareBeamCase } from '../src/verify/beamFixtures.ts';

describe('L6 手算对照算例（AGENTS.md 十一.5）', () => {
  for (const testCase of BEAM_VERIFY_CASES) {
    it(`${testCase.id} 与手算值在浮点舍入级一致`, () => {
      const result = runCheck(testCase.input);
      const comparison = compareBeamCase(result, testCase.expect);
      assert.ok(comparison.ok, `${testCase.id} 偏差：${comparison.deviations.join('；')}`);
      assert.ok(comparison.maxRelError <= 1e-9, `最大相对误差 ${comparison.maxRelError}`);
    });
  }
});

describe('L6 输出契约', () => {
  const base = BEAM_VERIFY_CASES[1]!.input;

  it('每个结果都携带公式、单位来源与保守性声明', () => {
    const result = runCheck(base);
    assert.ok(result.formulas.length >= 3);
    assert.ok(result.inputs.eSource.length > 0);
    assert.ok(result.inputs.allowableSource.length > 0);
    assert.ok(result.inputs.bendingNote.length > 0);
    assert.equal(result.verdict, 'pass');
    assert.equal(result.utilizations.stress, 0.25); // 20/80
  });

  it('缺挠度限值的梁工况标记 incomplete，不静默当通过', () => {
    const result = runCheck({ ...base, deflectionRatioLimit: null, deflectionSource: null });
    assert.equal(result.verdict, 'incomplete');
    assert.ok(result.warnings.some((w) => w.includes('未给挠度限值')));
  });

  it('限值有但来源缺失 → 拒绝（默认参数不得静默生效）', () => {
    assert.throws(
      () => runCheck({ ...base, deflectionSource: null }),
      (error: unknown) => error instanceof CheckError && error.reason === 'missing_source',
    );
  });

  it('压杆工况强制要求 safetyFactor、mu 与 muSource', () => {
    const col = BEAM_VERIFY_CASES[4]!.input;
    assert.throws(
      () => runCheck({ ...col, safetyFactor: null }),
      (e: unknown) => e instanceof CheckError && e.reason === 'missing_safety_factor',
    );
    assert.throws(
      () => runCheck({ ...col, mu: null, muSource: null }),
      (e: unknown) => e instanceof CheckError && e.reason === 'missing_mu',
    );
    assert.throws(
      () => runCheck({ ...col, muSource: '  ' }),
      (e: unknown) => e instanceof CheckError && e.reason === 'missing_source',
    );
  });

  it('梁工况给 safetyFactor 会被警告（避免双重安全系数）', () => {
    const result = runCheck({ ...base, safetyFactor: 2 });
    assert.ok(result.warnings.some((w) => w.includes('双重安全系数')));
  });

  it('欧拉临界力随 μ² 变化（铰接→固定端 μ=0.5 时 4 倍）', () => {
    const col = BEAM_VERIFY_CASES[4]!.input;
    const pinned = runCheck(col);
    const fixed = runCheck({ ...col, mu: 0.5 });
    assert.ok(
      Math.abs(fixed.eulerCriticalN! - 4 * pinned.eulerCriticalN!) <= 1e-6 * pinned.eulerCriticalN!,
      `${fixed.eulerCriticalN} vs 4×${pinned.eulerCriticalN}`,
    );
  });

  it('小挠度假设越界给出警告（δ/L > 1/50）', () => {
    const col = BEAM_VERIFY_CASES[0]!.input; // ss_udl
    const result = runCheck({
      ...col,
      lengthMm: U.mm(10_000),
      qNPerMm: col.qNPerMm,
    });
    assert.ok(
      result.warnings.some((w) => w.includes('小挠度')),
      `warnings: ${result.warnings.join('；')}`,
    );
  });
});

describe('L6 输入解析', () => {
  const ssPoint = {
    case: 'ss_point',
    lengthMm: 800,
    eMpa: 70000,
    eSource: '70 GPa：工程惯例',
    section: { areaMm2: 2500, iMm4: 2e6, wMm3: 1e4, bendingNote: '测试' },
    pN: 1000,
    allowableMpa: 80,
    allowableSource: '测试假设',
    deflectionRatioLimit: 250,
    deflectionSource: '工程惯例，非规范条文',
  };

  it('直接给 section 的完整输入可解析并校核', () => {
    const result = runCheck(parseCheckInput(ssPoint));
    assert.equal(result.verdict, 'pass');
  });

  it('给 profile 时由 L2 自算 A/I/W，并与直接算的截面特性一致', () => {
    const viaProfile = parseCheckInput({
      ...ssPoint,
      section: undefined,
      profile: SYN_2020_SPEC,
      bendingAxis: 'x',
    });
    const section = sectionFromProfile(SYN_2020_SPEC, 'x');
    assert.equal(viaProfile.section.areaMm2, section.areaMm2);
    assert.ok(Math.abs(viaProfile.section.iMm4 - 8749.64693335582) / 8749.64693335582 < 1e-9);
    assert.ok(section.bendingNote.includes('绕 x 轴'));
  });

  it('section 与 profile 必须二选一；未知字段拒绝', () => {
    assert.throws(
      () => parseCheckInput({ ...ssPoint, profile: SYN_2020_SPEC }),
      (e: unknown) => e instanceof CheckError && e.reason === 'invalid_input',
    );
    assert.throws(() => parseCheckInput({ ...ssPoint, junk: 1 }), /未知字段/);
    assert.throws(() => parseCheckInput({ ...ssPoint, case: 'torsion' }), /case 非法/);
  });

  it('eSource 为空字符串在校核层就被拒绝', () => {
    assert.throws(
      () => runCheck(parseCheckInput({ ...ssPoint, eSource: '   ' })),
      (e: unknown) => e instanceof CheckError && e.reason === 'missing_source',
    );
  });
});

describe('预设截面的保守取值（安全护栏）', () => {
  it('eu6060 走 profile 入口时取厂家公布 Ix，而不是偏大 3 倍的计算值', () => {
    const preset = findProfilePreset('eu6060')!;
    const section = sectionFromProfile(preset.spec, 'x');
    assert.equal(section.iMm4, 292000);
    assert.ok(section.iMm4 < 400000, '计算值 837428 不得成为校核输入');
    assert.match(section.bendingNote, /较小者/);
    assert.match(section.bendingNote, /米思米/);
  });

  it('eu2020 同样取公布值 7200 而非计算值 8847', () => {
    const preset = findProfilePreset('eu2020')!;
    assert.equal(sectionFromProfile(preset.spec, 'x').iMm4, 7200);
  });

  it('不在预设表里的自定义截面仍走计算值，不假装保守', () => {
    const custom = { width: 25, height: 25, slot: { opening: 6.15, depth: 4.5, headWidth: 9, headStart: 2 }, bore: { radius: 2.5 } };
    const section = sectionFromProfile(custom, 'x', 'A/I/W 由 L2 参数化截面自算');
    assert.match(section.bendingNote, /L2 参数化截面自算/);
    assert.equal(section.iMm4, sectionFromProfile(custom, 'x').iMm4);
  });

  it('与预设完全同参数的自定义 spec 会被识别并替换（口径一致优先）', () => {
    const clone = structuredClone(findProfilePreset('eu4545')!.spec);
    assert.equal(sectionFromProfile(clone, 'x').iMm4, 151200);
  });
});
