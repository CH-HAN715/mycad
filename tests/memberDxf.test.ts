import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFrame, parseFrameInput } from '../src/frame/model.ts';
import { planConnections } from '../src/connect/plan.ts';
import type { ConnectPlan } from '../src/connect/plan.ts';
import { DEFAULT_CONNECT_RULES } from '../src/connect/rules.ts';
import { MEMBER_DXF_PROVENANCE, memberDrawingsToDxf } from '../src/io/memberDxf.ts';

const P20 = {
  id: 'p20',
  spec: {
    width: 20,
    height: 20,
    slot: { opening: 6.15, depth: 4.5, headWidth: 9, headStart: 2 },
    bore: { radius: 2.5 },
  },
  material: { name: '6063-T5', densityKgPerM3: 2700 },
};

function exampleFrame(members?: unknown[]): ReturnType<typeof buildFrame> {
  return buildFrame(
    parseFrameInput({
      profiles: [P20],
      members:
        members ?? [
          { id: '底梁', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
          { id: '左柱', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] },
          { id: '右柱', profileId: 'p20', start: [600, 0, 0], end: [600, 0, 750] },
          { id: '顶梁', profileId: 'p20', start: [0, 0, 750], end: [600, 0, 750] },
          { id: '中立柱', profileId: 'p20', start: [300, 0, 750], end: [300, 0, 0] },
        ],
    }),
  );
}

describe('mycad memberDxf 孔位基准', () => {
  it('角接孔按端距 15mm，end 端从下料长倒推（手算 600-15=585）', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    const beam = out.holeLegend.filter((h) => h.memberId === '底梁');
    assert.deepEqual(
      beam.map((h) => h.alongBarMm),
      [15, 15, 585, 585, 300, 300],
    );
    assert.deepEqual(
      beam.map((h) => h.face),
      ['left', 'right', 'left', 'right', 'left', 'right'],
    );
  });

  it('T 接穿通杆在交点处得到 interior 孔，支杆自身不重复', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.equal(
      out.holeLegend.filter((h) => h.memberId === '底梁' && h.at === 'interior').length,
      2,
    );
    assert.equal(
      out.holeLegend.filter((h) => h.memberId === '中立柱' && h.at === 'interior').length,
      0,
    );
  });

  it('让量生效后孔位仍以物理端面起算（600-10=590，倒推 590-15=575）', () => {
    const model = exampleFrame([
      { id: '底梁', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0], trimStart: 10 },
      { id: '左柱', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] },
      { id: '右柱', profileId: 'p20', start: [600, 0, 0], end: [600, 0, 750] },
    ]);
    const out = memberDrawingsToDxf(model, planConnections(model));
    const beam = out.holeLegend.filter((h) => h.memberId === '底梁');
    assert.equal(model.members[0]!.cutLength, 590);
    assert.deepEqual(
      beam.map((h) => h.alongBarMm),
      [15, 15, 575, 575],
    );
  });

  it('孔位落在杆身外时只列表并告警，不画入视图', () => {
    const model = exampleFrame([
      { id: '底梁', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
    ]);
    const fake = {
      joints: [
        {
          holes: [
            {
              memberId: '底梁',
              at: 'start',
              face: 'left',
              fromJointEndMm: 700,
              alongStartMm: null,
              localU: -10,
              localV: 0,
              boltAxis: 'y',
              boltSeries: 'M5',
              diameterMm: 5,
              clearanceDrillMm: 5.5,
              tapDrillMm: 4.2,
              depthMm: null,
            },
          ],
        },
      ],
      rules: DEFAULT_CONNECT_RULES,
    } as unknown as ConnectPlan;
    const out = memberDrawingsToDxf(model, fake);
    assert.equal(out.holeLegend[0]!.inBar, false);
    assert.equal(out.stats.circles, 0);
    assert.match(out.warnings.join('\n'), /超出杆身/);
  });
});

describe('mycad memberDxf 钻孔与公差口径', () => {
  it('M5 通光孔按 ISO 273 中系列给 5.5，攻丝底孔 4.2，深度按通孔', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    const m5 = out.holeLegend.filter((h) => h.boltSeries === 'M5');
    assert.ok(m5.length > 0);
    assert.ok(m5.every((h) => h.clearanceDrillMm === 5.5));
    assert.ok(m5.every((h) => h.tapDrillMm === 4.2));
    assert.ok(m5.every((h) => h.depthMm === null));
    assert.match(out.dxf, /DRILL/);
    assert.match(out.dxf, /THRU/);
  });

  it('一般公差注记进图纸正文且来源随规则覆盖变化', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.toleranceNote, /ISO 2768/);
    assert.match(out.toleranceNote, /NOT A CONFORMITY CLAIM/);
    assert.ok(out.dxf.includes(out.toleranceNote));
    assert.match(out.drillSource, /ISO 273/);
  });

  it('覆盖钻孔表会同时改变图面与来源口径', () => {
    const model = exampleFrame();
    const plan = planConnections(model, {
      rules: { clearanceDrillBySeries: { M5: 5.3 }, drillTableSource: '用户实物复核值' },
    });
    const out = memberDrawingsToDxf(model, plan);
    assert.ok(out.holeLegend.every((h) => h.clearanceDrillMm === 5.3));
    assert.match(out.drillSource, /NON-ASCII/);
    assert.ok(out.dxf.includes('DRILL TABLE OVERRIDDEN'));
    assert.match(out.warnings.join('\n'), /非 ASCII/);
  });

  it('未知规则字段仍然直接拒绝', () => {
    const model = exampleFrame();
    assert.throws(
      () => planConnections(model, { rules: { clearanceDrillBySeriesWrong: { M5: 5 } } }),
      /未知字段/,
    );
  });
});

describe('mycad memberDxf 图纸文件', () => {
  it('R12 头、毫米单位与 EOF 齐全，实体计数与 stats 一致', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.dxf, /AC1009/);
    assert.match(out.dxf, /\$INSUNITS\n70\n4/);
    assert.ok(out.dxf.endsWith('EOF\n'));
    const count = (name: string): number =>
      out.dxf.split('\n').filter((line, i, all) => line === name && all[i - 1] === '0').length;
    assert.equal(count('CIRCLE'), out.stats.circles);
    assert.equal(count('TEXT'), out.stats.texts);
    assert.equal(out.stats.holes, 24);
  });

  it('DXF 文本不混入中文，杆件原名只出现在 legend 映射里', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.equal(/[^\x00-\x7F]/.test(out.dxf), false);
    assert.equal(out.memberLegend[0]!.memberId, '底梁');
    assert.equal(out.memberLegend[0]!.label, 'M1');
    assert.equal(out.memberLegend[0]!.materialName, '6063-T5');
  });

  it('空框架输出可读的空图，不抛异常', () => {
    const model = exampleFrame([]);
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.dxf, /NO MEMBERS/);
    assert.equal(out.stats.members, 0);
  });

  it('provenance 明确图纸不是可签收的下厂图', () => {
    assert.ok(MEMBER_DXF_PROVENANCE.limitations.some((l) => l.includes('公差')));
    assert.match(MEMBER_DXF_PROVENANCE.datum, /物理端面/);
    assert.match(MEMBER_DXF_PROVENANCE.disclaimer, /工程师/);
  });
});
