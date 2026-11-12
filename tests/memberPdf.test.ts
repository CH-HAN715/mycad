import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildFrame, parseFrameInput } from '../src/frame/model.ts';
import { planConnections } from '../src/connect/plan.ts';
import type { ConnectPlan } from '../src/connect/plan.ts';
import { DEFAULT_CONNECT_RULES } from '../src/connect/rules.ts';
import { MEMBER_PDF_PROVENANCE, memberDrawingsToPdf } from '../src/io/memberPdf.ts';
import { escapePdfText } from '../src/io/pdf.ts';

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

const asLatin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

function frameOf(members: unknown[]): ReturnType<typeof buildFrame> {
  return buildFrame(parseFrameInput({ profiles: [P20], members }));
}

const beam = (id: string, length: number): Record<string, unknown> => ({
  id,
  profileId: 'p20',
  start: [0, 0, 0],
  end: [length, 0, 0],
});

describe('mycad memberPdf 文件骨架', () => {
  it('PDF 1.4 头、页面树、xref 与 EOF 齐全，页数与 /Count 一致', () => {
    const model = frameOf([beam('A', 600)]);
    const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12' });
    const text = asLatin1(out.bytes);
    assert.match(text, /^%PDF-1\.4\n/);
    assert.match(text, /\/Type \/Catalog/);
    assert.match(text, /\/Type \/Pages/);
    assert.match(text, new RegExp(`/Count ${out.pages}`));
    assert.match(text, /xref/);
    assert.match(text, /trailer/);
    assert.match(text, /startxref/);
    assert.ok(text.endsWith('%%EOF\n'));
    assert.match(text, /\/BaseFont \/Helvetica/);
  });

  it('正文保持纯 ASCII，日期与页脚进图框', () => {
    const model = frameOf([beam('A', 600)]);
    const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12' });
    const text = asLatin1(out.bytes);
    assert.equal(/[^\x00-\x7F]/.test(text), false);
    assert.match(text, /DATE 2026-11-12/);
    assert.match(text, /NOT A CONFORMITY CLAIM/);
    assert.match(text, /MEMBER DRAWING/);
  });

  it('空框架输出一页 NO MEMBERS', () => {
    const model = frameOf([]);
    const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12' });
    assert.equal(out.pages, 1);
    assert.match(asLatin1(out.bytes), /NO MEMBERS/);
  });

  it('显式指定 A3 时页面尺寸随之变化', () => {
    const model = frameOf([beam('A', 600)]);
    const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12', page: 'A3' });
    assert.equal(out.pageSize, 'A3');
    const text = asLatin1(out.bytes);
    assert.match(text, /MediaBox \[0 0 1190\.551 841\.89\]/);
  });
});

describe('mycad memberPdf 比例与分页', () => {
  it('按杆长自动选标准比例：600mm→1:5，6000mm→1:50，12000mm→1:100', () => {
    // 手算：A4 可用视图宽 = 297-20-22-24 = 231mm；600/5=120，6000/50=120，12000/100=120。
    for (const [length, label] of [
      [600, '1:5'],
      [6000, '1:50'],
      [12000, '1:100'],
    ] as const) {
      const model = frameOf([beam('A', length)]);
      const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12' });
      assert.equal(out.blocks[0]!.scaleLabel, label);
      assert.match(asLatin1(out.bytes), new RegExp(`SCALE ${label.replace(':', ':')}`));
    }
  });

  it('多根杆自动分页，每块整块放置', () => {
    const model = frameOf([
      { id: 'A', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
      { id: 'B', profileId: 'p20', start: [0, 100, 0], end: [600, 100, 0] },
      { id: 'C', profileId: 'p20', start: [0, 200, 0], end: [600, 200, 0] },
    ]);
    const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12' });
    assert.equal(out.pages, 3);
    assert.deepEqual(
      out.blocks.map((b) => b.page),
      [1, 2, 3],
    );
    assert.match(asLatin1(out.bytes), /SHEET 1\/3/);
    assert.match(asLatin1(out.bytes), /SHEET 3\/3/);
  });

  it('块高超出页面时直接报错，不静默缩字或拆表', () => {
    const model = frameOf([beam('A', 600)]);
    const manyHoles = {
      joints: [
        {
          holes: Array.from({ length: 80 }, (_, i) => ({
            memberId: 'A',
            at: 'interior',
            face: 'left',
            fromJointEndMm: null,
            alongStartMm: 10 + i * 5,
            localU: -10,
            localV: 0,
            boltAxis: 'y',
            boltSeries: 'M5',
            diameterMm: 5,
            clearanceDrillMm: 5.5,
            tapDrillMm: 4.2,
            depthMm: null,
          })),
        },
      ],
      rules: DEFAULT_CONNECT_RULES,
      endCaps: [],
    } as unknown as ConnectPlan;
    assert.throws(
      () => memberDrawingsToPdf(model, manyHoles, { date: '2026-11-12' }),
      /排版失败/,
    );
  });
});

describe('mycad memberPdf 图面内容', () => {
  const jointFrame = (): ReturnType<typeof buildFrame> =>
    frameOf([
      { id: '底梁', profileId: 'p20', start: [0, 0, 0], end: [600, 0, 0] },
      { id: '左柱', profileId: 'p20', start: [0, 0, 0], end: [0, 0, 750] },
    ]);

  it('孔位表、基准与位置度进入 PDF，%%c 写作 DIA', () => {
    const model = jointFrame();
    const out = memberDrawingsToPdf(model, planConnections(model), { date: '2026-11-12' });
    const text = asLatin1(out.bytes);
    assert.match(text, /M1-H1/);
    assert.match(text, /DATUM A: START FACE/);
    assert.match(text, /ALL HOLES: POSITION/);
    assert.match(text, /DIA0\.40/);
    assert.equal(text.includes('%%c'), false);
    assert.ok(out.stats.circles > 0);
    assert.ok(out.holeLegend.length > 0);
  });

  it('provenance 说明字体、比例与剩余限制', () => {
    assert.match(MEMBER_PDF_PROVENANCE.format, /PDF 1\.4/);
    assert.ok(MEMBER_PDF_PROVENANCE.limitations.some((l) => l.includes('表面粗糙度')));
    assert.match(MEMBER_PDF_PROVENANCE.scale, /1:100|100/);
  });

  it('PDF 文本转义：括号与反斜杠，控制字符拒绝', () => {
    assert.equal(escapePdfText('a(b)\\c'), 'a\\(b\\)\\\\c');
    assert.throws(() => escapePdfText('a\nb'), /控制字符/);
  });
});
