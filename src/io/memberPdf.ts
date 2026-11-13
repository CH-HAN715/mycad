import type { FrameModel } from '../frame/model.ts';
import type { ConnectPlan } from '../connect/plan.ts';
import { DENSE_TYPOGRAPHY, layoutMemberDrawings } from './drawingLayout.ts';
import type { DrawingSink } from './drawingLayout.ts';
import type { HoleLegendRow, MemberLegendRow } from './drawingLayout.ts';
import { buildPdf, mmToPt, pdfCircle, pdfLine, pdfRect, pdfText } from './pdf.ts';

/**
 * L7 输出层：杆件加工图 PDF（A4/A3 横向、自动比例、分页）。
 *
 * 排版与 DXF 共用 drawingLayout.ts；本文件只做页面空间变换与 PDF 写出。
 * 文本保持纯 ASCII（Helvetica 内置字体）：DXF 的 %%c 写作 DIA，中文原名见 legend。
 */

export const MEMBER_PDF_PROVENANCE = {
  format: 'PDF 1.4（矢量线段/圆/文本，Helvetica 内置字体）',
  layout: '与 DXF 共用 drawingLayout.ts 排版；每根杆一块，块不跨页',
  scale: '标准比例 1:n（n = 1/2/5/10/20/50/100），按杆长与块高自动选择满足页面的最小 n',
  textNote: '%%c 直径控制符写作 DIA（纯 ASCII）；中文字符不进图面，原名见 legend',
  assumptions: [
    '页面 A4 横向 297×210mm（可选 A3 420×297mm），边距 10mm，页眉 10mm、页脚 8mm；A4 放不下时自动升 A3',
    '块高超出单页可用高度时直接报错，不静默拆表或缩小字号',
    '比例只作用于视图几何，文字与孔位表保持原尺寸',
    'PDF 使用紧凑排版（正文 2.5mm、行距 4mm）；DXF 保持 3.2mm/5mm，两者版式同源但字号不同',
  ],
  limitations: [
    '已给位置度、端面垂直度/平面度、孔壁圆柱度与孔轴垂直度（图形化符号框）、表面粗糙度 Ra 注记；同轴度对独立通光孔不适用；仍不含独立圆度、轮廓度等其余形位公差',
    '未嵌入字体：只保证 ASCII 文本的显示一致性',
    '未做标题栏签收区与公司图框定制',
  ],
  disclaimer: '与 DXF 相同：加工参考图，不是可签收的下厂图纸；投产前必须补齐工艺并由工程师确认。',
} as const;

export interface MemberPdfOptions {
  /** 图框日期 YYYY-MM-DD；默认取当天。 */
  readonly date?: string;
  /** 图框标题；默认 MYCAD。 */
  readonly title?: string;
  /** 页面规格；默认 A4 横向。 */
  readonly page?: 'A4' | 'A3';
}

export interface MemberPdfResult {
  readonly bytes: Uint8Array;
  readonly pages: number;
  readonly pageSize: 'A4' | 'A3';
  readonly blocks: readonly { memberLabel: string; page: number; scaleLabel: string }[];
  readonly warnings: readonly string[];
  readonly memberLegend: readonly MemberLegendRow[];
  readonly holeLegend: readonly HoleLegendRow[];
  readonly toleranceNote: string;
  readonly drillSource: string;
  /** 表面粗糙度来源标注（已保证 ASCII）。 */
  readonly roughnessSource: string;
  /** 方切端面对基准 B 的垂直度，mm。 */
  readonly endSquarenessMm: number;
  /** 端面平面度，mm。 */
  readonly endFlatnessMm: number;
  /** 孔壁圆柱度，mm。 */
  readonly holeCylindricityMm: number;
  /** 孔轴线对基准 B 的垂直度，mm。 */
  readonly holeAxisPerpMm: number;
  /** 加工面表面粗糙度 Ra，um。 */
  readonly surfaceRoughnessRaUm: number;
  readonly positionZoneMm: number;
  readonly stats: {
    readonly members: number;
    readonly holes: number;
    readonly circles: number;
    readonly texts: number;
  };
}

const PAGE_SIZES = { A4: { widthMm: 297, heightMm: 210 }, A3: { widthMm: 420, heightMm: 297 } } as const;
type PageSize = { readonly widthMm: number; readonly heightMm: number };
const MARGIN_MM = 10;
const HEADER_MM = 10;
const FOOTER_MM = 8;
const X_PAD_MM = 22;
const RIGHT_LABEL_MM = 36;
const BLOCK_GAP_MM = 8;
const LINE_WIDTH_PT = 0.6;
const STANDARD_SCALES = [1, 2, 5, 10, 20, 50, 100] as const;

type Prim =
  | { readonly kind: 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  | { readonly kind: 'circle'; readonly cx: number; readonly cy: number; readonly d: number }
  | { readonly kind: 'text'; readonly value: string; readonly x: number; readonly y: number; readonly h: number };

interface CollectedBlock {
  readonly prims: Prim[];
}

const noopSink: DrawingSink = {
  beginBlock: () => {},
  line: () => {},
  circle: () => {},
  text: () => {},
  endBlock: () => {},
};

export function memberDrawingsToPdf(
  model: FrameModel,
  plan: ConnectPlan,
  options: MemberPdfOptions = {},
): MemberPdfResult {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const title = options.title ?? 'MYCAD';
  const candidates: readonly ('A4' | 'A3')[] = options.page !== undefined ? [options.page] : ['A4', 'A3'];

  // 第一遍：1:1 测量每块内容高度；固定部分 = 总高 - 视图贡献（宽+高）×1。
  const measured = layoutMemberDrawings(model, plan, noopSink, { gapMm: BLOCK_GAP_MM, typography: DENSE_TYPOGRAPHY });
  const pickFor = (pageName: 'A4' | 'A3'): { size: PageSize; chosen: number[] } | null => {
    const size = PAGE_SIZES[pageName];
    const usableW = size.widthMm - 2 * MARGIN_MM;
    const contentH = size.heightMm - 2 * MARGIN_MM - HEADER_MM - FOOTER_MM;
    const maxViewW = usableW - X_PAD_MM - RIGHT_LABEL_MM;
    const chosen: number[] = [];
    for (const block of measured.blocks) {
      const member = model.members[block.memberIndex]!;
      const profile = model.profiles.find((p) => p.id === member.profileId);
      const width = profile !== undefined ? profile.spec.width : 20;
      const height = profile !== undefined ? profile.spec.height : 20;
      const fixedH = block.heightMm - (width + height);
      let picked = 0;
      for (const n of STANDARD_SCALES) {
        const s = 1 / n;
        if (member.cutLength * s <= maxViewW && fixedH + (width + height) * s <= contentH) {
          picked = n;
          break;
        }
      }
      if (picked === 0) return null;
      chosen.push(picked);
    }
    return { size, chosen };
  };
  let picked: { page: 'A4' | 'A3'; size: PageSize; chosen: number[] } | null = null;
  const failures: string[] = [];
  for (const name of candidates) {
    const result = pickFor(name);
    if (result !== null) {
      picked = { page: name, ...result };
      break;
    }
    failures.push(`${name} 上以最小比例 1:100 仍放不下（视图宽或内容高超出页面）`);
  }
  if (picked === null) {
    throw new RangeError(`杆件工程图排版失败：${failures.join('；')}；请拆分超长/多孔杆件或显式指定页面`);
  }
  const { page, size, chosen } = picked;
  const contentH = size.heightMm - 2 * MARGIN_MM - HEADER_MM - FOOTER_MM;
  const contentTopMm = size.heightMm - MARGIN_MM - HEADER_MM;

  // 第二遍：按选定比例收集图元，按块分桶。
  const buckets: CollectedBlock[] = model.members.map(() => ({ prims: [] }));
  let current = 0;
  const sink: DrawingSink = {
    beginBlock: (index) => {
      current = index;
    },
    line: (x1, y1, x2, y2) => {
      buckets[current]?.prims.push({ kind: 'line', x1, y1, x2, y2 });
    },
    circle: (cx, cy, d) => {
      buckets[current]?.prims.push({ kind: 'circle', cx, cy, d });
    },
    text: (value, x, y, h) => {
      buckets[current]?.prims.push({ kind: 'text', value, x, y, h });
    },
    endBlock: () => {},
  };
  const layout = layoutMemberDrawings(model, plan, sink, {
    gapMm: BLOCK_GAP_MM,
    typography: DENSE_TYPOGRAPHY,
    scaleOf: (index) => 1 / chosen[index]!,
  });

  // 分页：块整块放置，不跨页；块间留 BLOCK_GAP_MM。
  const pagesBlocks: number[][] = [[]];
  const placements = new Map<number, { page: number; cursorMm: number }>();
  let cursor = 0;
  let pageIndex = 0;
  layout.blocks.forEach((block, i) => {
    if (cursor > 0 && cursor + block.heightMm > contentH) {
      pageIndex += 1;
      pagesBlocks.push([]);
      cursor = 0;
    }
    if (block.heightMm > contentH) {
      throw new RangeError(`杆件 ${block.memberLabel} 内容高 ${block.heightMm.toFixed(1)}mm 超过单页可用 ${contentH.toFixed(0)}mm`);
    }
    pagesBlocks[pageIndex]!.push(i);
    placements.set(i, { page: pageIndex, cursorMm: cursor });
    cursor += block.heightMm + BLOCK_GAP_MM;
  });

  const warnings: string[] = [...layout.warnings];
  layout.blocks.forEach((block) => {
    if (block.scale < 1) {
      warnings.push(`杆件 ${block.memberLabel} 视图按 1:${Math.round(1 / block.scale)} 绘制`);
    }
  });

  const pageOps: string[] = pagesBlocks.map((indices, p) => {
    const ops: string[] = [];
    ops.push(pdfRect(mmToPt(MARGIN_MM), mmToPt(MARGIN_MM), mmToPt(size.widthMm - 2 * MARGIN_MM), mmToPt(size.heightMm - 2 * MARGIN_MM), LINE_WIDTH_PT));
    ops.push(pdfText(`${title}  MEMBER DRAWING`, mmToPt(MARGIN_MM + 2), mmToPt(size.heightMm - MARGIN_MM - 4), mmToPt(3.5)));
    ops.push(pdfText(`SHEET ${p + 1}/${pagesBlocks.length}`, mmToPt(size.widthMm - MARGIN_MM - 24), mmToPt(size.heightMm - MARGIN_MM - 4), mmToPt(3.5)));
    ops.push(
      pdfText(
        `UNIT mm | SCALE AS MARKED | DATE ${date} | NOT A CONFORMITY CLAIM`,
        mmToPt(MARGIN_MM + 2),
        mmToPt(MARGIN_MM + 2),
        mmToPt(2.6),
      ),
    );

    if (layout.blocks.length === 0) {
      ops.push(pdfText('NO MEMBERS', mmToPt(MARGIN_MM + X_PAD_MM), mmToPt(contentTopMm - 20), mmToPt(4.5)));
    }

    for (const i of indices) {
      const block = layout.blocks[i]!;
      const place = placements.get(i)!;
      const yTopMm = contentTopMm - place.cursorMm;
      ops.push(pdfText(`SCALE 1:${chosen[i]}`, mmToPt(MARGIN_MM + X_PAD_MM + 115), mmToPt(yTopMm - 4), mmToPt(3.2)));
      for (const prim of buckets[i]!.prims) {
        if (prim.kind === 'text') {
          const yMm = yTopMm - (block.topMm - prim.y);
          ops.push(pdfText(prim.value.replaceAll('%%c', 'DIA'), mmToPt(MARGIN_MM + X_PAD_MM + prim.x), mmToPt(yMm), mmToPt(prim.h)));
        } else if (prim.kind === 'circle') {
          const yMm = yTopMm - (block.topMm - prim.cy);
          ops.push(pdfCircle(mmToPt(MARGIN_MM + X_PAD_MM + prim.cx), mmToPt(yMm), mmToPt(prim.d / 2), LINE_WIDTH_PT));
        } else {
          ops.push(
            pdfLine(
              mmToPt(MARGIN_MM + X_PAD_MM + prim.x1),
              mmToPt(yTopMm - (block.topMm - prim.y1)),
              mmToPt(MARGIN_MM + X_PAD_MM + prim.x2),
              mmToPt(yTopMm - (block.topMm - prim.y2)),
              LINE_WIDTH_PT,
            ),
          );
        }
      }
    }
    return ops.join('\n');
  });

  const bytes = buildPdf(pageOps, {
    widthPt: mmToPt(size.widthMm),
    heightPt: mmToPt(size.heightMm),
    title: `${title} member drawing ${date}`,
  });

  return {
    bytes,
    pages: pageOps.length,
    pageSize: page,
    blocks: layout.blocks.map((block, i) => ({
      memberLabel: block.memberLabel,
      page: placements.get(i)!.page + 1,
      scaleLabel: `1:${chosen[i]}`,
    })),
    warnings,
    memberLegend: layout.memberLegend,
    holeLegend: layout.holeLegend,
    toleranceNote: layout.toleranceNote,
    drillSource: layout.drillSource,
    roughnessSource: layout.roughnessSource,
    endSquarenessMm: layout.endSquarenessMm,
    endFlatnessMm: layout.endFlatnessMm,
    holeCylindricityMm: layout.holeCylindricityMm,
    holeAxisPerpMm: layout.holeAxisPerpMm,
    surfaceRoughnessRaUm: layout.surfaceRoughnessRaUm,
    positionZoneMm: layout.positionZoneMm,
    stats: layout.stats,
  };
}
