import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { v3 } from '../src/geom/vec3.ts';
import { buildFrame } from '../src/frame/model.ts';
import type { FrameInput } from '../src/frame/model.ts';
import { ConnectError, parseConnectInput, planConnections } from '../src/connect/plan.ts';
import { DEFAULT_CONNECT_RULES, matchFastenerSeries, parseRulesOverride } from '../src/connect/rules.ts';

const SLOT_20 = {
  width: 20,
  height: 20,
  slot: { opening: 6, depth: 5.5, headWidth: 8, headStart: 2 },
  bore: { radius: 2.25, segments: 8 },
} as const;

const SLOT_40 = {
  width: 40,
  height: 40,
  slot: { opening: 8, depth: 8, headWidth: 12, headStart: 3 },
  bore: { radius: 5, segments: 16 },
} as const;

const SOLID_20 = { width: 20, height: 20 } as const;

function frame(profiles: FrameInput['profiles'], members: FrameInput['members']): FrameInput {
  return { profiles, members };
}

describe('L3 规则表', () => {
  it('槽口宽按区间映射到螺纹系列', () => {
    assert.equal(matchFastenerSeries(DEFAULT_CONNECT_RULES, 6).matched && 'M5', 'M5');
    assert.equal(matchFastenerSeries(DEFAULT_CONNECT_RULES, 8).matched && 'M6', 'M6');
    assert.equal(matchFastenerSeries(DEFAULT_CONNECT_RULES, 10).matched && 'M8', 'M8');
    const miss = matchFastenerSeries(DEFAULT_CONNECT_RULES, 20);
    assert.equal(miss.matched, false);
    if (!miss.matched) assert.ok(miss.reason.includes('不在任何规则区间'));
  });

  it('规则覆盖是浅合并，未知字段拒绝', () => {
    const merged = parseRulesOverride({ bracketHolePitchMm: 40 });
    assert.equal(merged.bracketHolePitchMm, 40);
    assert.equal(merged.bracketEdgeMarginMm, DEFAULT_CONNECT_RULES.bracketEdgeMarginMm);
    assert.equal(merged.source, DEFAULT_CONNECT_RULES.source);
    assert.throws(() => parseRulesOverride({ typoField: 1 }), /未知字段/);
    assert.throws(() => parseRulesOverride({ bracketHolePitchMm: -1 }), /正的有限数/);
    assert.throws(() => parseRulesOverride({ source: '  ' }), /非空字符串/);
  });

  it('自定义 fastenerSeries 必须带区间上下界', () => {
    const custom = parseRulesOverride({
      fastenerSeries: [{ openingMinMm: 5, openingMaxMm: 7, boltSeries: 'M5' }],
    });
    assert.equal(custom.fastenerSeries.length, 1);
    assert.ok(custom.fastenerSeries[0]!.rationale.includes('用户自定义'));
    assert.throws(
      () => parseRulesOverride({ fastenerSeries: [{ openingMinMm: 7, openingMaxMm: 5, boltSeries: 'M5' }] }),
      /openingMaxMm >= openingMinMm/,
    );
  });

  it('垂直度与表面粗糙度可覆盖，且来源不得留空', () => {
    const merged = parseRulesOverride({ tolEndSquarenessMm: 0.1, surfaceRoughnessRaUm: 1.6 });
    assert.equal(merged.tolEndSquarenessMm, 0.1);
    assert.equal(merged.surfaceRoughnessRaUm, 1.6);
    assert.equal(merged.roughnessSource, DEFAULT_CONNECT_RULES.roughnessSource);
    assert.throws(() => parseRulesOverride({ tolEndSquarenessMm: 0 }), /正的有限数/);
    assert.throws(() => parseRulesOverride({ surfaceRoughnessRaUm: -3.2 }), /正的有限数/);
    assert.throws(() => parseRulesOverride({ roughnessSource: ' ' }), /非空字符串/);
  });
});

describe('L3 角接（corner）', () => {
  const input = frame(
    [{ id: 'p20', spec: SLOT_20 }],
    [
      { id: 'h1', profileId: 'p20', start: v3(0, 0, 0), end: v3(200, 0, 0) },
      { id: 'v1', profileId: 'p20', start: v3(200, 0, 0), end: v3(200, 150, 0) },
    ],
  );

  it('两面角自动选角件：两个安装面、螺栓系列来自 6mm 槽、端头让半边宽', () => {
    const plan = planConnections(buildFrame(input));
    assert.equal(plan.joints.length, 1);
    const joint = plan.joints[0]!;
    assert.equal(joint.kind, 'corner');
    assert.equal(joint.strategy, 'angle-bracket');

    const bracket = joint.hardware.find((h) => h.kind === 'angle-bracket')!;
    assert.equal(bracket.quantity, 2); // ±z 两个面都有槽
    assert.equal(bracket.size, 'M5');

    // 每个成员在 top/bottom 各 1 孔（20 宽放不进第二个 20 间距孔）
    assert.equal(joint.holes.length, 4);
    for (const hole of joint.holes) {
      assert.equal(hole.boltSeries, 'M5');
      assert.equal(hole.diameterMm, 5);
      assert.equal(hole.boltAxis, 'z');
      if (hole.memberId === 'h1') assert.equal(hole.at, 'end');
      if (hole.memberId === 'v1') assert.equal(hole.at, 'start');
      assert.equal(hole.fromJointEndMm, DEFAULT_CONNECT_RULES.bracketHoleOffsetFromEndMm);
    }

    const trim = joint.recommendedTrims.find((t) => t.memberId === 'h1')!;
    assert.equal(trim.end, 'end');
    assert.equal(trim.trimMm, 10); // v1 沿 x 的半边宽 = 20/2
    assert.equal(joint.recommendedTrims.length, 1);
  });

  it('无槽型材的角接输出 manual 并说明原因', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'ps', spec: SOLID_20 }],
          [
            { id: 'a', profileId: 'ps', start: v3(0, 0, 0), end: v3(100, 0, 0) },
            { id: 'b', profileId: 'ps', start: v3(100, 0, 0), end: v3(100, 100, 0) },
          ],
        ),
      ),
    );
    const joint = plan.joints[0]!;
    assert.equal(joint.strategy, 'manual');
    assert.ok(joint.warnings.some((w) => w.includes('没有槽')));
    assert.equal(joint.hardware.length, 0);
  });

  it('40 系列（8mm 槽）单面放 2 个孔、系列为 M6', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'p40', spec: SLOT_40 }],
          [
            { id: 'a', profileId: 'p40', start: v3(0, 0, 0), end: v3(200, 0, 0) },
            { id: 'b', profileId: 'p40', start: v3(200, 0, 0), end: v3(200, 200, 0) },
          ],
        ),
      ),
    );
    const joint = plan.joints[0]!;
    assert.equal(joint.holes.length, 8); // 2 面 × 2 孔 × 2 杆
    assert.ok(joint.holes.every((h) => h.boltSeries === 'M6'));
    const xs = [...new Set(joint.holes.filter((h) => h.memberId === 'a').map((h) => h.fromJointEndMm as number))].sort((p, q) => p - q);
    assert.deepEqual(xs, [15, 35]);
  });
});

describe('L3 T 接与对接', () => {
  it('端点落在杆件内部识别为 tee，穿通杆侧面孔围绕交点对称', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'p20', spec: SLOT_20 }],
          [
            { id: 'h1', profileId: 'p20', start: v3(0, 0, 0), end: v3(400, 0, 0) },
            { id: 't1', profileId: 'p20', start: v3(200, -100, 0), end: v3(200, 0, 0) },
          ],
        ),
      ),
    );
    const tee = plan.joints.find((j) => j.kind === 'tee')!;
    assert.ok(tee, `未识别出 tee：${JSON.stringify(plan.joints.map((j) => j.kind))}`);
    assert.equal(tee.strategy, 'angle-bracket');
    assert.equal(tee.throughMemberId, 'h1');
    const interior = tee.holes.filter((h) => h.at === 'interior');
    assert.equal(interior.length, 2); // 两面各 1
    for (const hole of interior) {
      assert.equal(hole.memberId, 'h1');
      assert.equal(hole.alongStartMm, 200); // n=1 时孔就在交点
      assert.equal(hole.fromJointEndMm, null);
    }
    const trim = tee.recommendedTrims[0]!;
    assert.equal(trim.memberId, 't1');
    assert.equal(trim.trimMm, 10);
  });

  it('同轴对接在有中心孔时输出内置对接棒', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'p20', spec: SLOT_20 }],
          [
            { id: 's1', profileId: 'p20', start: v3(0, 0, 0), end: v3(300, 0, 0) },
            { id: 's2', profileId: 'p20', start: v3(300, 0, 0), end: v3(600, 0, 0) },
          ],
        ),
      ),
    );
    const joint = plan.joints[0]!;
    assert.equal(joint.kind, 'splice');
    assert.equal(joint.strategy, 'internal-peg');
    const peg = joint.hardware.find((h) => h.kind === 'peg')!;
    assert.equal(peg.size, 'Ø4.00'); // 2×2.25 − 0.5
    assert.equal(peg.lengthMm, 40);
    assert.ok(joint.recommendedTrims.every((t) => t.trimMm === 0));
  });

  it('无中心孔的对接输出 manual 并解释', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'ps', spec: SOLID_20 }],
          [
            { id: 's1', profileId: 'ps', start: v3(0, 0, 0), end: v3(300, 0, 0) },
            { id: 's2', profileId: 'ps', start: v3(300, 0, 0), end: v3(600, 0, 0) },
          ],
        ),
      ),
    );
    assert.equal(plan.joints[0]!.strategy, 'manual');
    assert.ok(plan.joints[0]!.warnings.some((w) => w.includes('中心孔')));
  });
});

describe('L3 分类边界', () => {
  it('三杆共点（箱体角）v1 不自动选型', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'p20', spec: SLOT_20 }],
          [
            { id: 'ax', profileId: 'p20', start: v3(0, 0, 0), end: v3(100, 0, 0) },
            { id: 'ay', profileId: 'p20', start: v3(0, 0, 0), end: v3(0, 100, 0) },
            { id: 'az', profileId: 'p20', start: v3(0, 0, 0), end: v3(0, 0, 100) },
          ],
        ),
      ),
    );
    const joint = plan.joints.find((j) => j.kind === 'undecided')!;
    assert.ok(joint);
    assert.equal(joint.strategy, 'manual');
    assert.ok(joint.warnings[0]!.includes('端点共点'));
  });

  it('悬空端点被列出但不生成连接', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'p20', spec: SLOT_20 }],
          [{ id: 'lonely', profileId: 'p20', start: v3(0, 0, 0), end: v3(100, 0, 0) }],
        ),
      ),
    );
    assert.deepEqual(plan.singleEnds, ['lonely.start', 'lonely.end']);
    assert.equal(plan.joints.length, 0);
  });

  it('连接件汇总跨关节累加', () => {
    const plan = planConnections(
      buildFrame(
        frame(
          [{ id: 'p20', spec: SLOT_20 }],
          [
            { id: 'a1', profileId: 'p20', start: v3(0, 0, 0), end: v3(100, 0, 0) },
            { id: 'b1', profileId: 'p20', start: v3(100, 0, 0), end: v3(100, 100, 0) },
            { id: 'a2', profileId: 'p20', start: v3(0, 100, 0), end: v3(100, 100, 0) },
          ],
        ),
      ),
    );
    const brackets = plan.hardwareSummary.find((h) => h.kind === 'angle-bracket')!;
    assert.equal(brackets.quantity, 4); // 两个角 × 每个角 2 面
    const nuts = plan.hardwareSummary.find((h) => h.kind === 'slot-nut')!;
    assert.equal(nuts.quantity, 8); // 每角 2 面 × 每面 1+1 孔 × 2 角
  });
});

describe('L3 connect 输入解析', () => {
  it('裸框架 JSON 与 {"frame","options"} 两种形式都接受', () => {
    const bare = {
      profiles: [{ id: 'p', spec: SLOT_20 }],
      members: [
        { id: 'a', profileId: 'p', start: [0, 0, 0], end: [100, 0, 0] },
        { id: 'b', profileId: 'p', start: [100, 0, 0], end: [100, 100, 0] },
      ],
    };
    assert.deepEqual(parseConnectInput(bare).options, {});
    const wrapped = parseConnectInput({ frame: bare, options: { rules: { bracketHolePitchMm: 30 } } });
    assert.equal(wrapped.options.rules?.bracketHolePitchMm, 30);
    assert.throws(() => parseConnectInput({ frame: bare, junk: 1 }), (e: unknown) => e instanceof ConnectError);
    assert.throws(
      () => parseConnectInput({ frame: bare, options: { junk: 1 } }),
      (e: unknown) => e instanceof ConnectError && e.hint.includes('只支持 rules'),
    );
  });

  it('非法 rules 走 ConnectError 且 reason=invalid_rules', () => {
    const model = buildFrame(frame([{ id: 'p', spec: SLOT_20 }], [{ id: 'a', profileId: 'p', start: v3(0, 0, 0), end: v3(10, 0, 0) }]));
    try {
      planConnections(model, { rules: { bracketHolePitchMm: 0 } });
      assert.fail('应当抛出');
    } catch (error) {
      assert.ok(error instanceof ConnectError);
      assert.equal(error.reason, 'invalid_rules');
      assert.equal(error.code, 'E_INPUT_CONNECT');
    }
  });
});

describe('自由端端盖', () => {
  it('悬空端点生成端盖需求并进入汇总', () => {
    const model = buildFrame(
      frame(
        [{ id: 'pa', spec: SLOT_40 }],
        [
          { id: 'A', profileId: 'pa', start: v3(0, 0, 0), end: v3(600, 0, 0) },
          { id: 'B', profileId: 'pa', start: v3(0, 0, 0), end: v3(0, 0, 750) },
          { id: 'lonely', profileId: 'pa', start: v3(600, 0, 0), end: v3(600, 400, 0) },
        ],
      ),
    );
    const plan = planConnections(model);
    assert.deepEqual(plan.singleEnds, ['B.end', 'lonely.end']);
    assert.deepEqual(
      plan.endCaps.map((c) => [c.memberId, c.end, c.widthMm, c.heightMm]),
      [
        ['B', 'end', 40, 40],
        ['lonely', 'end', 40, 40],
      ],
    );
    const cap = plan.hardwareSummary.find((h) => h.kind === 'end-cap');
    assert.ok(cap !== undefined);
    assert.equal(cap.quantity, 2);
    assert.equal(cap.size, '40x40');
    assert.match(cap.label, /无零件号/);
  });

  it('闭合回路没有端盖行，两根杆的角接仍按自由端计', () => {
    const closed = buildFrame(
      frame(
        [{ id: 'pa', spec: SLOT_40 }],
        [
          { id: 'A', profileId: 'pa', start: v3(0, 0, 0), end: v3(600, 0, 0) },
          { id: 'B', profileId: 'pa', start: v3(600, 0, 0), end: v3(600, 600, 0) },
          { id: 'C', profileId: 'pa', start: v3(600, 600, 0), end: v3(0, 600, 0) },
          { id: 'D', profileId: 'pa', start: v3(0, 600, 0), end: v3(0, 0, 0) },
        ],
      ),
    );
    const closedPlan = planConnections(closed);
    assert.deepEqual(closedPlan.endCaps, []);
    assert.equal(closedPlan.hardwareSummary.some((h) => h.kind === 'end-cap'), false);

    const twoBars = buildFrame(
      frame(
        [{ id: 'pa', spec: SLOT_40 }],
        [
          { id: 'A', profileId: 'pa', start: v3(0, 0, 0), end: v3(600, 0, 0) },
          { id: 'B', profileId: 'pa', start: v3(0, 0, 0), end: v3(0, 0, 750) },
        ],
      ),
    );
    assert.deepEqual(planConnections(twoBars).singleEnds, ['A.end', 'B.end']);
  });
});

describe('45° 斜切角接（opt-in）', () => {
  const miterFrame = (second: FrameInput['profiles'][number]['spec']) =>
    buildFrame(
      frame(
        [{ id: 'pa', spec: SLOT_40 }, { id: 'pb', spec: second }],
        [
          { id: 'A', profileId: 'pa', start: v3(0, 0, 0), end: v3(600, 0, 0) },
          { id: 'B', profileId: 'pb', start: v3(0, 0, 0), end: v3(0, 0, 750) },
        ],
      ),
    );

  it('默认策略不变：仍是角件与 8 个孔', () => {
    const plan = planConnections(miterFrame(SLOT_40));
    assert.equal(plan.cornerStrategy, 'bracket');
    assert.equal(plan.joints[0]!.strategy, 'angle-bracket');
    assert.equal(plan.joints[0]!.holes.length, 8);
    assert.deepEqual(plan.joints[0]!.miters, []);
  });

  it('等截面时给 45° 斜切，长点=中心线+半宽、短点=中心线-半宽（手算 620/580 与 770/730）', () => {
    const plan = planConnections(miterFrame(SLOT_40), { cornerStrategy: 'miter45' });
    const joint = plan.joints[0]!;
    assert.equal(joint.strategy, 'miter-45');
    assert.equal(joint.holes.length, 0);
    assert.deepEqual(joint.miters.map((m) => [m.memberId, m.end, m.angleDeg, m.longPointMm, m.shortPointMm, m.view]), [
      ['A', 'start', 45, 620, 580, 'side'],
      ['B', 'start', 45, 770, 730, 'top'],
    ]);
    for (const cut of joint.miters) {
      assert.equal((cut.longPointMm + cut.shortPointMm) / 2, cut.memberId === 'A' ? 600 : 750);
    }
    assert.match(joint.warnings.join('\n'), /斜角连接件的孔位/);
  });

  it('截面不等时退回角件并说明原因，不硬凑一个假斜角', () => {
    const plan = planConnections(miterFrame(SLOT_20), { cornerStrategy: 'miter45' });
    const joint = plan.joints[0]!;
    assert.equal(joint.strategy, 'angle-bracket');
    assert.deepEqual(joint.miters, []);
    assert.ok(joint.holes.length > 0);
    assert.match(joint.warnings.join('\n'), /截面半宽不等/);
  });

  it('非法 cornerStrategy 直接拒绝', () => {
    assert.throws(
      () => planConnections(miterFrame(SLOT_40), { cornerStrategy: 'miter30' as 'miter45' }),
      /只支持 bracket 与 miter45/,
    );
  });

  it('connect 输入可带 cornerStrategy，未知字段仍拒绝', () => {
    const parsed = parseConnectInput({
      frame: { profiles: [{ id: 'p', spec: SLOT_20 }], members: [] },
      options: { cornerStrategy: 'miter45' },
    });
    assert.equal(parsed.options.cornerStrategy, 'miter45');
    assert.throws(
      () => parseConnectInput({ frame: { profiles: [], members: [] }, options: { cornerStrat: 'miter45' } }),
      /未知字段/,
    );
    assert.throws(
      () => parseConnectInput({ frame: { profiles: [], members: [] }, options: { cornerStrategy: 'nope' } }),
      /只支持 bracket 与 miter45/,
    );
  });
});
