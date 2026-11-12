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
    assert.equal(out.stats.circles, 1, '仅剩位置度符号圆，越界孔不画');
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

describe('mycad memberDxf 斜切端头', () => {
  const miterModel = (): ReturnType<typeof buildFrame> =>
    buildFrame(
      parseFrameInput({
        profiles: [
          {
            id: 'p40',
            spec: {
              width: 40,
              height: 40,
              slot: { opening: 8, depth: 8, headWidth: 12, headStart: 3 },
              bore: { radius: 5, segments: 16 },
            },
          },
        ],
        members: [
          { id: 'A', profileId: 'p40', start: [0, 0, 0], end: [600, 0, 0] },
          { id: 'B', profileId: 'p40', start: [0, 0, 0], end: [0, 0, 750] },
        ],
      }),
    );

  it('斜切块写入角度与长短点，并画出切割轨迹线', () => {
    const model = miterModel();
    const plan = planConnections(model, { cornerStrategy: 'miter45' });
    const out = memberDrawingsToDxf(model, plan);
    assert.match(out.dxf, /MITER 45 \+\/-0\.2 AT START LONG=620\.00 SHORT=580\.00 VIEW=SIDE/);
    assert.match(out.dxf, /MITER 45 \+\/-0\.2 AT START LONG=770\.00 SHORT=730\.00 VIEW=TOP/);
    assert.match(
      out.dxf,
      /CUT LENGTH 620\.00 mm \+\/-0\.30 \(STOCK\)\s+CENTERLINE 600\.00 mm\s+MITER ALLOWANCE 20\.00 mm/,
    );
    assert.match(out.dxf, /TOL: LENGTH \+\/-0\.30\s+HOLE POS \+\/-0\.20\s+DEPTH \+\/-0\.20\s+ANGLE \+\/-0\.2\s+THREAD 6H\s+SRC: JLCFA/);
    const groups: Record<string, string>[] = [];
    const lines = out.dxf.split('\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] !== '0') continue;
      const kind = lines[i + 1];
      if (kind !== 'LINE') continue;
      const g: Record<string, string> = {};
      let j = i + 2;
      for (; j < lines.length - 1 && lines[j] !== '0'; j += 2) g[lines[j]!] = lines[j + 1]!;
      groups.push(g);
      i = j - 1;
    }
    const diagonals = groups.filter(
      (g) => g['8'] === 'DIM' && Math.abs(+g['11']! - +g['10']!) > 1 && Math.abs(+g['21']! - +g['20']!) > 1,
    );
    assert.equal(diagonals.length, 2, '两根杆各一条斜切轨迹线');
    assert.ok(
      diagonals.every((g) => Math.abs(+g['11']! - +g['10']!) === 40 && Math.abs(+g['21']! - +g['20']!) === 40),
      '轨迹线应横跨长短点差 40mm 与视图高 40mm',
    );
    assert.equal(out.holeLegend.length, 0);
  });

  it('provenance 声明长点朝向需对照模型确认', () => {
    assert.ok(
      MEMBER_DXF_PROVENANCE.limitations.some((l) => l.includes('长点位于哪一侧')),
      '斜切边界必须写进 limitations',
    );
  });
});

describe('mycad memberDxf 长度公差分档', () => {
  const beamOf = (length: number) =>
    buildFrame(
      parseFrameInput({
        profiles: [P20],
        members: [{ id: '梁', profileId: 'p20', start: [0, 0, 0], end: [length, 0, 0] }],
      }),
    );

  it('1000mm 及以下走短档 ±0.3，超过走 ±0.5（阈值算短档）', () => {
    const atThreshold = memberDrawingsToDxf(beamOf(1000), planConnections(beamOf(1000)));
    assert.match(atThreshold.dxf, /CUT LENGTH 1000\.00 mm \+\/-0\.30/);
    const beyond = memberDrawingsToDxf(beamOf(1200), planConnections(beamOf(1200)));
    assert.match(beyond.dxf, /CUT LENGTH 1200\.00 mm \+\/-0\.50/);
    assert.match(beyond.dxf, /TOL: LENGTH \+\/-0\.50/);
  });

  it('孔位表每行都带 POS-TOL，且数值随规则覆盖变化', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.dxf, /POS-TOL/);
    assert.match(out.dxf, /M1-H1\s+LEFT\s+15\.00.*\+\/-0\.20/);
    const overridden = memberDrawingsToDxf(
      model,
      planConnections(model, { rules: { tolHolePositionMm: 0.1, toleranceSource: 'shop measured' } }),
    );
    assert.match(overridden.dxf, /HOLE POS \+\/-0\.10/);
    assert.match(overridden.dxf, /SRC: shop measured/);
  });
});

describe('mycad memberDxf 基准与孔深工艺口径', () => {
  const P40x20 = {
    id: 'p',
    spec: {
      width: 40,
      height: 20,
      slot: { opening: 6.15, depth: 4.5, headWidth: 9, headStart: 2 },
      bore: { radius: 2.5 },
    },
  };
  const frameOf = (members: unknown[]): ReturnType<typeof buildFrame> =>
    buildFrame(parseFrameInput({ profiles: [P40x20], members }));

  it('datum A/B 标签在两个视图各一处，表头同时声明 A/B 定义', () => {
    const model = frameOf([{ id: 'A', profileId: 'p', start: [0, 0, 0], end: [600, 0, 0] }]);
    const out = memberDrawingsToDxf(model, planConnections(model));
    const labelCount = (label: string): number =>
      out.dxf.split('\n').filter((line) => line === label).length;
    assert.equal(labelCount('DATUM A'), 2, '顶面与侧面视图各一处 A');
    assert.equal(labelCount('DATUM B'), 2, '顶面与侧面视图各一处 B');
    assert.match(out.dxf, /DATUM A: START FACE \(x=0\)\s+DATUM B: SECTION CENTERLINE/);
  });

  it('孔深行程按视图方向取截面尺寸：左/右面孔取宽 40，顶/底面孔取高 20', () => {
    // 手算：x-z 角接中，沿 x 的杆孔落在左/右面（u 面），行程 = 截面宽 40；
    // 沿 z 的杆孔落在顶/底面（v 面），行程 = 截面高 20。
    const xz = frameOf([
      { id: 'A', profileId: 'p', start: [0, 0, 0], end: [600, 0, 0] },
      { id: 'B', profileId: 'p', start: [0, 0, 0], end: [0, 0, 750] },
    ]);
    const xzOut = memberDrawingsToDxf(xz, planConnections(xz));
    const a = xzOut.holeLegend.filter((h) => h.memberId === 'A');
    const b = xzOut.holeLegend.filter((h) => h.memberId === 'B');
    assert.ok(a.length > 0 && b.length > 0);
    assert.ok(a.every((h) => h.face === 'left' || h.face === 'right'));
    assert.ok(b.every((h) => h.face === 'top' || h.face === 'bottom'));
    assert.match(xzOut.dxf, /M1-H1\s+.*THRU\(40\.0\)/);
    assert.match(xzOut.dxf, /M2-H1\s+.*THRU\(20\.0\)/);

    // 手算：x-y 角接的螺栓轴为 z，两杆孔都在顶/底面，行程统一取截面高 20。
    const xy = frameOf([
      { id: 'A', profileId: 'p', start: [0, 0, 0], end: [600, 0, 0] },
      { id: 'B', profileId: 'p', start: [0, 0, 0], end: [0, 600, 0] },
    ]);
    const xyOut = memberDrawingsToDxf(xy, planConnections(xy));
    assert.ok(xyOut.holeLegend.length > 0);
    assert.ok(xyOut.holeLegend.every((h) => h.face === 'top' || h.face === 'bottom'));
    assert.match(xyOut.dxf, /THRU\(20\.0\)/);
    assert.doesNotMatch(xyOut.dxf, /THRU\(40\.0\)/);
  });

  it('工艺注记声明通孔口径与螺纹归属，螺纹等级随规则覆盖变化', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.dxf, /NOTE 1: ALL HOLES CLR \(CLEARANCE\), THRU/);
    assert.match(out.dxf, /NOTE 2: THREAD 6H APPLIES TO MATING SLOT NUT\/INSERT, NOT THIS PART/);
    const overridden = memberDrawingsToDxf(
      model,
      planConnections(model, { rules: { threadClass: '6G' } }),
    );
    assert.match(overridden.dxf, /NOTE 2: THREAD 6G APPLIES/);
  });

  it('provenance 记录基准定义、通孔口径与未覆盖的形位公差', () => {
    assert.match(MEMBER_DXF_PROVENANCE.datum, /datum B/);
    assert.match(MEMBER_DXF_PROVENANCE.datum, /截面中心线/);
    assert.ok(MEMBER_DXF_PROVENANCE.assumptions.some((a) => a.includes('CLR-THRU')));
    assert.ok(MEMBER_DXF_PROVENANCE.assumptions.some((a) => a.includes('内接圆')));
    assert.ok(MEMBER_DXF_PROVENANCE.limitations.some((l) => l.includes('表面粗糙度')));
  });
});

describe('mycad memberDxf 位置度标注', () => {
  const entitiesOf = (dxf: string): { kind: string; g: Record<string, string> }[] => {
    const lines = dxf.split('\n');
    const out: { kind: string; g: Record<string, string> }[] = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (lines[i] !== '0') continue;
      const kind = lines[i + 1]!;
      if (kind !== 'LINE' && kind !== 'CIRCLE' && kind !== 'TEXT') continue;
      const g: Record<string, string> = {};
      let j = i + 2;
      for (; j < lines.length - 1 && lines[j] !== '0'; j += 2) g[lines[j]!] = lines[j + 1]!;
      out.push({ kind, g });
      i = j - 1;
    }
    return out;
  };

  it('每根杆画一个位置度框：符号圆、A/B 引用与 2x 换算的直径区', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.dxf, /ALL HOLES: POSITION \(GD&T FRAME\)/);
    assert.match(out.dxf, /%%c0\.40/);
    assert.match(out.dxf, /NOTE 3: ZONE %%c0\.40 = 2 x \+\/-0\.20 \(INSCRIBED CIRCLE OF \+\/- SQUARE; CONSERVATIVE\)/);
    assert.equal(out.positionZoneMm, 0.4);
    const entities = entitiesOf(out.dxf);
    const gdtCircles = entities.filter((e) => e.kind === 'CIRCLE' && e.g['8'] === 'GDT');
    const gdtLines = entities.filter((e) => e.kind === 'LINE' && e.g['8'] === 'GDT');
    assert.equal(gdtCircles.length, model.members.length, '每根杆一个位置度符号圆');
    assert.equal(gdtLines.length, 9 * model.members.length, '框体 4 + 分隔 3 + 十字 2');
    assert.ok(gdtCircles.every((c) => Number(c.g['40']) === 2), '符号圆半径 2mm');
  });

  it('覆盖孔位公差时位置度区与注记同步变化', () => {
    const model = exampleFrame();
    const out = memberDrawingsToDxf(
      model,
      planConnections(model, { rules: { tolHolePositionMm: 0.1 } }),
    );
    assert.equal(out.positionZoneMm, 0.2);
    assert.match(out.dxf, /%%c0\.20/);
    assert.match(out.dxf, /NOTE 3: ZONE %%c0\.20 = 2 x \+\/-0\.10/);
    assert.doesNotMatch(out.dxf, /%%c0\.40/);
  });
});

describe('mycad memberDxf 端盖注记', () => {
  it('自由端在图上写出 END CAP 与截面尺寸', () => {
    const model = exampleFrame([
      { id: '底梁', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
      { id: '左柱', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] },
    ]);
    const out = memberDrawingsToDxf(model, planConnections(model));
    assert.match(out.dxf, /END CAP 20x20 AT END/);
    assert.equal(out.holeLegend.length, 4);
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
