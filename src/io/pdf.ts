/**
 * L7 输出层：零依赖 PDF 1.4 写出器。
 *
 * 只覆盖工程图需要的子集：线段、矩形、圆（贝塞尔逼近）、Helvetica 文本。
 * 文本必须纯 ASCII（WinAnsi 内置字体）；调用方负责在进入前降级。
 */

const MM_PER_INCH = 25.4;
const PT_PER_INCH = 72;

export function mmToPt(mm: number): number {
  return (mm / MM_PER_INCH) * PT_PER_INCH;
}

/** PDF 字符串转义；控制字符直接拒绝，避免生成坏文件。 */
export function escapePdfText(value: string): string {
  if (/[\x00-\x1F]/.test(value)) {
    throw new RangeError('PDF 文本不能包含控制字符');
  }
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/** 坐标与线宽保留 3 位小数，控制文件体积；调试时可读。 */
const f = (value: number): string => {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

export function pdfLine(x1: number, y1: number, x2: number, y2: number, widthPt: number): string {
  return `${f(widthPt)} w\n${f(x1)} ${f(y1)} m\n${f(x2)} ${f(y2)} l\nS`;
}

export function pdfRect(x: number, y: number, w: number, h: number, widthPt: number): string {
  return `${f(widthPt)} w\n${f(x)} ${f(y)} ${f(w)} ${f(h)} re\nS`;
}

/** 圆的四段三次贝塞尔逼近，最大径向误差约 0.027%。 */
export function pdfCircle(cx: number, cy: number, radiusPt: number, widthPt: number): string {
  const r = radiusPt;
  const k = 0.5522847498 * r;
  return [
    `${f(widthPt)} w`,
    `${f(cx + r)} ${f(cy)} m`,
    `${f(cx + r)} ${f(cy + k)} ${f(cx + k)} ${f(cy + r)} ${f(cx)} ${f(cy + r)} c`,
    `${f(cx - k)} ${f(cy + r)} ${f(cx - r)} ${f(cy + k)} ${f(cx - r)} ${f(cy)} c`,
    `${f(cx - r)} ${f(cy - k)} ${f(cx - k)} ${f(cy - r)} ${f(cx)} ${f(cy - r)} c`,
    `${f(cx + k)} ${f(cy - r)} ${f(cx + r)} ${f(cy - k)} ${f(cx + r)} ${f(cy)} c`,
    'S',
  ].join('\n');
}

export function pdfText(value: string, x: number, y: number, sizePt: number): string {
  return `BT /F1 ${f(sizePt)} Tf 1 0 0 1 ${f(x)} ${f(y)} Tm (${escapePdfText(value)}) Tj ET`;
}

export interface PdfDocumentOptions {
  /** 页面尺寸，pt。 */
  readonly widthPt: number;
  readonly heightPt: number;
  readonly title?: string;
}

/** 组装 PDF：Catalog / Pages / 每页 Page+Contents / 共享 Helvetica / Info。 */
export function buildPdf(pages: readonly string[], options: PdfDocumentOptions): Uint8Array {
  if (pages.length === 0) throw new RangeError('PDF 至少需要一页');
  const pageCount = pages.length;
  const fontObj = 3 + 2 * pageCount;
  const infoObj = fontObj + 1;
  const objects: string[] = [];

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + 2 * i} 0 R`).join(' ');
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  pages.forEach((content, i) => {
    const pageObj = 3 + 2 * i;
    const contentObj = 4 + 2 * i;
    objects[pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(options.widthPt)} ${f(options.heightPt)}] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`;
    objects[contentObj] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  });
  objects[fontObj] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[infoObj] = `<< /Title (${escapePdfText(options.title ?? 'mycad drawing')}) /Producer (mycad) >>`;

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i <= infoObj; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = out.length;
  out += `xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= infoObj; i++) {
    out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
