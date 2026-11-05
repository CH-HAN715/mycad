import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { v3 } from '../src/geom/vec3.ts';
import { FrameInputError, buildFrame, parseFrameInput } from '../src/frame/model.ts';
import type { FrameInput } from '../src/frame/model.ts';
import { buildBom } from '../src/production/bom.ts';
import { planCuts } from '../src/production/cutPlan.ts';

const SOLID_20 = { width: 20, height: 20 } as const;

const FRAME: FrameInput = {
  profiles: [
    {
      id: 'p20',
      spec: SOLID_20,
      material: { name: '6063-T5', densityKgPerM3: 2700 },
    },
  ],
  members: [
    { id: 'h1', profileId: 'p20', start: v3(0, 0, 0), end: v3(600, 0, 0) },
    { id: 'h2', profileId: 'p20', start: v3(0, 400, 0), end: v3(600, 400, 0) },
    { id: 'v1', profileId: 'p20', start: v3(0, 0, 0), end: v3(0, 400, 0) },
    { id: 'v2', profileId: 'p20', start: v3(600, 0, 0), end: v3(600, 400, 0) },
  ],
};

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof FrameInputError ? error.reason : `NOT_FRAME_ERROR:${String(error)}`;
  }
}

function assertClose(actual: number, expected: number, label: string, tol = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label}: 期望 ${expected}，实测 ${actual}，绝对误差 ${Math.abs(actual - expected)}`,
  );
}

describe('L4 轴对齐框架求解', () => {
  it('矩形框架的长度、体积与质量可手算复核', () => {
    const model = buildFrame(FRAME);
    assert.equal(model.members.length, 4);
    assert.equal(model.joints.length, 4);
    for (const joint of model.joints) assert.equal(joint.memberCount, 2);

    const byId = new Map(model.members.map((m) => [m.id, m]));
    const h1 = byId.get('h1')!;
    const v1 = byId.get('v1')!;
    assert.equal(h1.axis, 'x');
    assert.equal(v1.axis, 'y');
    assertClose(h1.centerlineLength, 600, 'h1 中心线');
    assertClose(v1.centerlineLength, 400, 'v1 中心线');
    assertClose(h1.cutLength, 600, 'h1 下料长度');
    assertClose(h1.area, 400, '面积');
    assertClose(h1.volume, 240000, 'h1 体积');
    // 0.648 kg = 240000 mm^3 × 1e-9 m^3/mm^3 × 2700 kg/m^3
    assertClose(h1.mass!, 0.648, 'h1 质量');
    assertClose(model.members.reduce((sum, m) => sum + (m.mass ?? 0), 0), 2.16, '总质量');
  });

  it('端部让量从中心线长度中扣除', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [{ id: 'm', profileId: 'p20', start: v3(0, 0, 0), end: v3(1000, 0, 0), trimStart: 20, trimEnd: 30 }],
    };
    const model = buildFrame(input);
    assertClose(model.members[0]!.centerlineLength, 1000, '中心线');
    assertClose(model.members[0]!.cutLength, 950, '下料长度');
  });

  it('让量耗尽杆件时拒绝', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [{ id: 'm', profileId: 'p20', start: v3(0, 0, 0), end: v3(100, 0, 0), trimStart: 60, trimEnd: 60 }],
    };
    assert.equal(reasonOf(() => buildFrame(input)), 'non_positive_cut_length');
  });

  it('斜杆被拒绝', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [{ id: 'm', profileId: 'p20', start: v3(0, 0, 0), end: v3(100, 100, 0) }],
    };
    assert.equal(reasonOf(() => buildFrame(input)), 'not_axis_aligned');
  });

  it('两端点重合被拒绝', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [{ id: 'm', profileId: 'p20', start: v3(0, 0, 0), end: v3(0, 0, 0) }],
    };
    assert.equal(reasonOf(() => buildFrame(input)), 'degenerate_member');
  });

  it('共线重叠杆件被拒绝', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [
        { id: 'a', profileId: 'p20', start: v3(0, 0, 0), end: v3(500, 0, 0) },
        { id: 'b', profileId: 'p20', start: v3(400, 0, 0), end: v3(900, 0, 0) },
      ],
    };
    assert.equal(reasonOf(() => buildFrame(input)), 'overlapping_members');
  });

  it('端点相接不算重叠', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [
        { id: 'a', profileId: 'p20', start: v3(0, 0, 0), end: v3(500, 0, 0) },
        { id: 'b', profileId: 'p20', start: v3(500, 0, 0), end: v3(900, 0, 0) },
      ],
    };
    const model = buildFrame(input);
    assert.equal(model.joints.length, 3);
    assert.equal(model.joints.find((j) => j.memberCount === 2)!.point.x, 500);
  });

  it('重复 id 与未知型材被拒绝', () => {
    const dupProfile: FrameInput = {
      profiles: [{ id: 'p', spec: SOLID_20 }, { id: 'p', spec: SOLID_20 }],
      members: [],
    };
    assert.equal(reasonOf(() => buildFrame(dupProfile)), 'duplicate_id');

    const dupMember: FrameInput = {
      profiles: [{ id: 'p', spec: SOLID_20 }],
      members: [
        { id: 'm', profileId: 'p', start: v3(0, 0, 0), end: v3(10, 0, 0) },
        { id: 'm', profileId: 'p', start: v3(0, 10, 0), end: v3(10, 10, 0) },
      ],
    };
    assert.equal(reasonOf(() => buildFrame(dupMember)), 'duplicate_id');

    const unknown: FrameInput = {
      profiles: [{ id: 'p', spec: SOLID_20 }],
      members: [{ id: 'm', profileId: 'nope', start: v3(0, 0, 0), end: v3(10, 0, 0) }],
    };
    assert.equal(reasonOf(() => buildFrame(unknown)), 'unknown_profile');
  });
});

describe('框架 JSON 解析', () => {
  it('接受数组点与对象点，未知字段拒绝', () => {
    const parsed = parseFrameInput({
      profiles: [{ id: 'p', spec: { width: 20, height: 20 } }],
      members: [
        { id: 'a', profileId: 'p', start: [0, 0, 0], end: { x: 100, y: 0, z: 0 } },
      ],
    });
    assert.equal(parsed.members[0]!.start.z, 0);
    assert.equal(reasonOf(() => parseFrameInput({ profiles: [], members: [], extra: 1 })), 'invalid_input');
  });

  it('三维点缺少坐标被拒绝', () => {
    assert.equal(
      reasonOf(() =>
        parseFrameInput({
          profiles: [{ id: 'p', spec: { width: 20, height: 20 } }],
          members: [{ id: 'a', profileId: 'p', start: [0, 0], end: [1, 0, 0] }],
        }),
      ),
      'invalid_input',
    );
  });
});

describe('L5 BOM', () => {
  it('下料清单按型材与长度分组，数量与总长可手算', () => {
    const model = buildFrame(FRAME);
    const bom = buildBom(model);
    assert.equal(bom.totalMembers, 4);
    assertClose(bom.totalCutLengthMm, 2000, '总下料长度');
    assertClose(bom.totalVolumeMm3, 800000, '总体积');
    assertClose(bom.totalMassKg!, 2.16, '总质量');
    assert.equal(bom.missingMaterialFor.length, 0);
    assert.equal(bom.stockPlan, null);

    const cut600 = bom.cutList.find((item) => item.lengthMm === 600)!;
    const cut400 = bom.cutList.find((item) => item.lengthMm === 400)!;
    assert.equal(cut600.quantity, 2);
    assert.equal(cut600.pieceLengthTotalMm, 1200);
    assert.equal(cut400.quantity, 2);
    assert.equal(cut400.pieceLengthTotalMm, 800);
  });

  it('提供棒料参数时附带下料方案', () => {
    const bom = buildBom(buildFrame(FRAME), { stockLengthMm: 6000, kerfMm: 3 });
    assert.ok(bom.stockPlan !== null);
    assert.equal(bom.stockPlan.bars.length, 1);
    assert.equal(bom.stockPlan.matchesLowerBound, true);
    assertClose(bom.stockPlan.totalPieceLengthMm, 2000, '成品长度');
    assertClose(bom.stockPlan.totalKerfLossMm, 12, '锯缝损耗');
    assertClose(bom.stockPlan.totalLeftoverMm, 3988, '余料');
    assertClose(bom.stockPlan.utilization, 2000 / 6000, '利用率');
  });

  it('缺少材料密度时质量输出 null，不猜', () => {
    const input: FrameInput = {
      profiles: [{ id: 'p20', spec: SOLID_20 }],
      members: [{ id: 'm', profileId: 'p20', start: v3(0, 0, 0), end: v3(1000, 0, 0) }],
    };
    const bom = buildBom(buildFrame(input));
    assert.equal(bom.totalMassKg, null);
    assert.deepEqual(bom.missingMaterialFor, ['p20']);
    assert.equal(bom.profiles[0]!.totalMassKg, null);
  });
});

describe('下料求解器', () => {
  it('单根棒料即可装下，余料与利用率可手算', () => {
    const plan = planCuts(
      [
        { id: 'a', lengthMm: 600, quantity: 2 },
        { id: 'b', lengthMm: 400, quantity: 2 },
      ],
      { stockLengthMm: 6000, kerfMm: 3 },
    );
    assert.equal(plan.bars.length, 1);
    assert.equal(plan.totalPieces, 4);
    assert.equal(plan.matchesLowerBound, true);
    assertClose(plan.totalPieceLengthMm, 2000, '成品长度');
    assertClose(plan.totalKerfLossMm, 12, '锯缝');
    assertClose(plan.totalLeftoverMm, 3988, '余料');
    assertClose(plan.totalWasteMm, 4000, '总损耗');
  });

  it('多根棒料时按降序装箱，报告下界差距', () => {
    const plan = planCuts([{ id: 'a', lengthMm: 600, quantity: 3 }], { stockLengthMm: 1000, kerfMm: 0 });
    assert.equal(plan.bars.length, 3);
    assert.equal(plan.lowerBoundBars, 2);
    assert.equal(plan.gapBars, 1);
    assert.equal(plan.matchesLowerBound, false);
  });

  it('超长段被拒绝', () => {
    assert.throws(
      () => planCuts([{ id: 'a', lengthMm: 1200, quantity: 1 }], { stockLengthMm: 1000, kerfMm: 5 }),
      /超过棒料/,
    );
  });

  it('数量非法被拒绝', () => {
    assert.throws(() => planCuts([{ id: 'a', lengthMm: 100, quantity: 0 }], { stockLengthMm: 1000 }), /正整数/);
    assert.throws(() => planCuts([{ id: 'a', lengthMm: 100, quantity: 1.5 }], { stockLengthMm: 1000 }), /正整数/);
  });

  it('锯缝按每段计一次（保守）', () => {
    assert.throws(
      () => planCuts([{ id: 'a', lengthMm: 990, quantity: 1 }], { stockLengthMm: 1000, kerfMm: 11 }),
      /超过棒料/,
    );
    const ok = planCuts([{ id: 'a', lengthMm: 989, quantity: 1 }], { stockLengthMm: 1000, kerfMm: 11 });
    assert.equal(ok.bars.length, 1);
    assertClose(ok.bars[0]!.usedMm, 1000, '占用');
    assertClose(ok.bars[0]!.leftoverMm, 0, '余料');
  });
});
