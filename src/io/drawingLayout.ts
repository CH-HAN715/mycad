import type { FrameModel } from '../frame/model.ts';
import type { ConnectPlan, ConnectorHole, MiterCut } from '../connect/plan.ts';
import type { ConnectRules } from '../connect/rules.ts';

/**
 * L7 输出层：杆件加工图的共享排版。
 *
 * 只负责「画什么、画在哪」，把图元推给 DrawingSink；DXF 与 PDF 各自实现 sink。
 * 两套输出共用同一份排版，避免孔位、注记或基准在两处漂移。
 * 坐标约定：图纸 mm，y 向上，文档顶部为 0，向下为负。
 */

export interface DrawingSink {
  beginBlock(memberIndex: number, memberLabel: string): void;
  line(x1: number, y1: number, x2: number, y2: number, layer: string): void;
  circle(cx: number, cy: number, diameterMm: number, layer: string): void;
  text(value: string, x: number, y: number, heightMm: number, layer: string): void;
  endBlock(memberIndex: number): void;
}

export interface MemberLegendRow {
  readonly label: string;
  readonly memberId: string;
  readonly profileId: string;
  readonly cutLengthMm: number;
  readonly trimStartMm: number;
  readonly trimEndMm: number;
  readonly materialName: string | null;
}

export interface HoleLegendRow {
  readonly label: string;
  readonly memberLabel: string;
  readonly memberId: string;
  readonly face: string;
  readonly at: ConnectorHole['at'];
  /** 距 start 端物理端面的距离，mm；无法定位时为 null。 */
  readonly alongBarMm: number | null;
  readonly diameterMm: number | null;
  /** 通光孔钻孔直径，mm；系列不在钻孔表内为 null。 */
  readonly clearanceDrillMm: number | null;
  /** 攻丝底孔直径，mm；选择攻丝工艺时使用。 */
  readonly tapDrillMm: number | null;
  /** 孔深，mm；null 表示通孔。 */
  readonly depthMm: number | null;
  readonly boltSeries: string;
  readonly boltAxis: string;
  /** 孔位是否落在 0..cutLength 之内；false 表示只列表未画入视图。 */
  readonly inBar: boolean;
}

export interface LayoutBlock {
  readonly memberIndex: number;
  readonly memberLabel: string;
  readonly memberId: string;
  /** 块顶图纸 y（y 向上）。 */
  readonly topMm: number;
  /** 块底图纸 y，不含块尾留白。 */
  readonly bottomMm: number;
  /** 内容高度 mm = top - bottom。 */
  readonly heightMm: number;
  /** 视图比例，1 = 1:1。 */
  readonly scale: number;
}

/** 排版字体与行距，mm；PDF 用紧凑档，DXF 用默认档。 */
export interface LayoutTypography {
  readonly titleRow: number;
  readonly rowStep: number;
  readonly viewGap: number;
  readonly dimRow: number;
  readonly tableHead: number;
  readonly tableRow: number;
  readonly blockTail: number;
  readonly textH: number;
  readonly titleH: number;
}

export const DEFAULT_TYPOGRAPHY: LayoutTypography = {
  titleRow: 8,
  rowStep: 5,
  viewGap: 14,
  dimRow: 14,
  tableHead: 12,
  tableRow: 7,
  blockTail: 26,
  textH: 3.2,
  titleH: 4.5,
};

export const DENSE_TYPOGRAPHY: LayoutTypography = {
  titleRow: 6,
  rowStep: 4,
  // 视图间距与尺寸区间距被基准标签（引线 6 + 框高 5）占用，保持 14mm 不压缩。
  viewGap: 14,
  dimRow: 14,
  tableHead: 8,
  tableRow: 5,
  blockTail: 10,
  textH: 2.5,
  titleH: 3.5,
};

export interface LayoutOptions {
  /** 每根杆的视图比例；默认 1。 */
  readonly scaleOf?: (memberIndex: number) => number;
  /** 块间留白 mm；默认 34。 */
  readonly gapMm?: number;
  /** 轮廓与孔所在图层名；默认 MYCAD。 */
  readonly layer?: string;
  /** 字体与行距覆盖；默认 DEFAULT_TYPOGRAPHY。 */
  readonly typography?: Partial<LayoutTypography>;
}

export interface LayoutResult {
  readonly memberLegend: readonly MemberLegendRow[];
  readonly holeLegend: readonly HoleLegendRow[];
  readonly warnings: readonly string[];
  /** 图纸上实际写出的公差注记（已保证 ASCII）。 */
  readonly toleranceNote: string;
  /** 位置度直径区，mm = 2 × tolHolePositionMm（± 方差的保守内接圆）。 */
  readonly positionZoneMm: number;
  /** 钻孔直径表来源，随规则覆盖变化。 */
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
  readonly blocks: readonly LayoutBlock[];
  readonly stats: {
    readonly members: number;
    readonly holes: number;
    readonly circles: number;
    readonly texts: number;
  };
}

/** 长度公差按阈值分档；等于阈值算短档（与来源页的 L<=1000 口径一致）。 */
function tolLength(valueMm: number, rules: ConnectRules): number {
  return valueMm <= rules.tolLengthThresholdMm ? rules.tolLengthShortMm : rules.tolLengthLongMm;
}

/** 图面正文必须是 ASCII：用户覆盖的注记含中文时降级并告警，不写进图。 */
export function asciiOnly(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '');
}

const LAYER_CENTER = 'CENTER';
const LAYER_TEXT = 'TEXT';
const LAYER_DIM = 'DIM';
const LAYER_DATUM = 'DATUM';
const LAYER_GDT = 'GDT';
const DEFAULT_GAP = 34;

/** 孔在杆件轴上的位置：start 端从 0 起算，end 端从 cutLength 倒推。 */
export function alongBarMm(hole: ConnectorHole, cutLength: number): number | null {
  if (hole.at === 'interior') return hole.alongStartMm;
  if (hole.fromJointEndMm === null) return null;
  return hole.at === 'start' ? hole.fromJointEndMm : cutLength - hole.fromJointEndMm;
}

const num = (value: number | null): string => (value === null ? '-' : value.toFixed(2));

export function layoutMemberDrawings(
  model: FrameModel,
  plan: ConnectPlan,
  sink: DrawingSink,
  options: LayoutOptions = {},
): LayoutResult {
  const rules = plan.rules;
  const rawNote = rules.generalToleranceNote;
  const rawDrill = rules.drillTableSource;
  const rawRough = rules.roughnessSource;
  const toleranceNote = asciiOnly(rawNote) || 'GENERAL TOL NOT STATED (SEE LEGEND)';
  const drillSource = asciiOnly(rawDrill) || 'DRILL TABLE OVERRIDDEN (SOURCE NON-ASCII, SEE LEGEND)';
  const roughnessSource = asciiOnly(rawRough) || 'ROUGHNESS SOURCE NOT STATED';
  const warnings: string[] = [];
  if (asciiOnly(rawNote).length !== rawNote.length || asciiOnly(rawDrill).length !== rawDrill.length) {
    warnings.push('generalToleranceNote 或 drillTableSource 含非 ASCII 字符，已从图面剔除，原文见返回字段与 legend');
  }
  if (asciiOnly(rawRough).length !== rawRough.length) {
    warnings.push('roughnessSource 含非 ASCII 字符，已从图面剔除，原文见返回字段与 legend');
  }
  const gapMm = options.gapMm ?? DEFAULT_GAP;
  const layer = options.layer ?? 'MYCAD';
  const t = { ...DEFAULT_TYPOGRAPHY, ...(options.typography ?? {}) };

  const holesByMember = new Map<string, ConnectorHole[]>();
  const mitersByMember = new Map<string, MiterCut[]>();
  for (const joint of plan.joints) {
    for (const hole of joint.holes) {
      const bucket = holesByMember.get(hole.memberId);
      if (bucket === undefined) holesByMember.set(hole.memberId, [hole]);
      else bucket.push(hole);
    }
    for (const cut of joint.miters ?? []) {
      const bucket = mitersByMember.get(cut.memberId);
      if (bucket === undefined) mitersByMember.set(cut.memberId, [cut]);
      else bucket.push(cut);
    }
  }

  const memberLegend: MemberLegendRow[] = [];
  const holeLegend: HoleLegendRow[] = [];
  const blocks: LayoutBlock[] = [];
  let circles = 0;
  let texts = 0;
  let skippedLabels = 0;
  let originY = 0;

  model.members.forEach((member, index) => {
    const profile = model.profiles.find((p) => p.id === member.profileId);
    const width = profile !== undefined ? profile.spec.width : 20;
    const height = profile !== undefined ? profile.spec.height : 20;
    const length = member.cutLength;
    const memberLabel = `M${index + 1}`;
    const holes = holesByMember.get(member.id) ?? [];
    const scale = options.scaleOf?.(index) ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new RangeError(`杆件 ${member.id} 的视图比例必须是正数，收到 ${scale}`);
    }
    const viewLength = length * scale;
    const viewWidth = width * scale;
    const viewHeight = height * scale;
    const blockTop = originY;
    /** 已放置的孔标签位置，用于避让；按视图分开。 */
    const labelSlots: { readonly x: number; readonly y: number }[] = [];

    memberLegend.push({
      label: memberLabel,
      memberId: member.id,
      profileId: member.profileId,
      cutLengthMm: length,
      trimStartMm: member.trimStart,
      trimEndMm: member.trimEnd,
      materialName: profile?.material?.name ?? null,
    });

    sink.beginBlock(index, memberLabel);

    // 局部坐标用「y 向下」书写，落笔时统一翻到图纸坐标，避免正负号在脑子里换算。
    const Y = (down: number): number => originY - down;
    const hLine = (x1: number, x2: number, down: number, lyr: string): void =>
      sink.line(x1, Y(down), x2, Y(down), lyr);
    const vLine = (x: number, d1: number, d2: number, lyr: string): void =>
      sink.line(x, Y(d1), x, Y(d2), lyr);
    const box = (x: number, top: number, w: number, h: number, lyr: string): void => {
      hLine(x, x + w, top, lyr);
      hLine(x, x + w, top + h, lyr);
      vLine(x, top, top + h, lyr);
      vLine(x + w, top, top + h, lyr);
    };
    const text = (value: string, x: number, down: number, h: number, lyr: string): void => {
      texts += 1;
      sink.text(value, x, Y(down), h, lyr);
    };

    let down = 0;
    text(`${memberLabel}  CUT=${num(length)}  SECTION=${num(width)}x${num(height)}`, 0, down, t.titleH, LAYER_TEXT);
    down += t.titleRow;
    text(`TRIM ${num(member.trimStart)} / ${num(member.trimEnd)}   DATUM A: START FACE (x=0)   DATUM B: SECTION CENTERLINE   HOLES: ${holes.length}`, 0, down, t.textH, LAYER_TEXT);
    down += t.titleRow;

    // 基准标注：A = start 端面，B = 截面中心线。符号用引线加标签表达。
    const datumTags = (viewTop: number, viewSize: number): void => {
      const base = viewTop + viewSize;
      sink.line(-14, Y(base + 6), 0, Y(base), LAYER_DATUM);
      box(-14, base + 6, 27, 5, LAYER_DATUM);
      text('DATUM A', -13, base + 7.2, t.textH - 0.8, LAYER_DATUM);
      text('DATUM B', viewLength + 6, viewTop + viewSize / 2 + 1.2, t.textH - 0.8, LAYER_DATUM);
    };

    const topViewAt = down;
    box(0, topViewAt, viewLength, viewWidth, layer);
    hLine(0, viewLength, topViewAt + viewWidth / 2, LAYER_CENTER);
    datumTags(topViewAt, viewWidth);
    text('TOP VIEW', viewLength + 18, topViewAt, t.textH, LAYER_TEXT);
    down = topViewAt + viewWidth + t.viewGap;

    const sideViewAt = down;
    box(0, sideViewAt, viewLength, viewHeight, layer);
    hLine(0, viewLength, sideViewAt + viewHeight / 2, LAYER_CENTER);
    datumTags(sideViewAt, viewHeight);
    text('SIDE VIEW', viewLength + 18, sideViewAt, t.textH, LAYER_TEXT);
    down = sideViewAt + viewHeight + t.dimRow;

    for (const cut of mitersByMember.get(member.id) ?? []) {
      const half = ((cut.longPointMm - cut.shortPointMm) / 2) * scale;
      const at = cut.end === 'end' ? viewLength : 0;
      const viewAt = cut.view === 'top' ? topViewAt : sideViewAt;
      const viewSize = cut.view === 'top' ? viewWidth : viewHeight;
      sink.line(at - half, Y(viewAt), at + half, Y(viewAt + viewSize), LAYER_DIM);
      text(
        `MITER ${cut.angleDeg} +/-${rules.tolAngleDeg.toFixed(1)} AT ${cut.end.toUpperCase()} LONG=${num(cut.longPointMm)} SHORT=${num(cut.shortPointMm)} VIEW=${cut.view.toUpperCase()}`,
        0,
        down,
        t.textH,
        LAYER_DIM,
      );
      down += t.rowStep;
    }

    const miters = mitersByMember.get(member.id) ?? [];
    let stockLength: number = length;
    for (const cut of miters) stockLength += (cut.longPointMm - cut.shortPointMm) / 2;

    hLine(0, viewLength, down, LAYER_DIM);
    vLine(0, down - 3, down + 3, LAYER_DIM);
    vLine(viewLength, down - 3, down + 3, LAYER_DIM);
    down += t.rowStep - 1;
    text(
      miters.length === 0
        ? `CUT LENGTH ${num(length)} mm +/-${tolLength(stockLength, rules).toFixed(2)}`
        : `CUT LENGTH ${num(stockLength)} mm +/-${tolLength(stockLength, rules).toFixed(2)} (STOCK)  CENTERLINE ${num(length)} mm  MITER ALLOWANCE ${num(stockLength - length)} mm`,
      0,
      down,
      t.textH,
      LAYER_DIM,
    );
    down += t.rowStep;
    text(toleranceNote, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    text(`DRILL TABLE: ${drillSource}`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    text('NOTE 1: ALL HOLES CLR (CLEARANCE), THRU; DEPTH CELL THRU(<D>) = MIN DRILL TRAVEL THROUGH SECTION', 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    text(`NOTE 2: THREAD ${asciiOnly(rules.threadClass) || 'UNSPECIFIED'} APPLIES TO MATING SLOT NUT/INSERT, NOT THIS PART`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    text(
      `TOL: LENGTH +/-${tolLength(stockLength, rules).toFixed(2)}  HOLE POS +/-${rules.tolHolePositionMm.toFixed(2)}  DEPTH +/-${rules.tolHoleDepthMm.toFixed(2)}  ANGLE +/-${rules.tolAngleDeg.toFixed(1)}  THREAD ${asciiOnly(rules.threadClass) || 'UNSPECIFIED'}  SRC: ${asciiOnly(rules.toleranceSource) || 'NOT STATED'}`,
      0,
      down,
      t.textH,
      LAYER_DIM,
    );
    down += t.rowStep;

    // 位置度框：符号格（圆+十字）| 直径区 | A | B。符号与框用线段画。
    const zoneMm = 2 * rules.tolHolePositionMm;
    text('ALL HOLES: POSITION (GD&T FRAME)', 0, down, t.textH, LAYER_DIM);
    down += t.rowStep - 1;
    const gdtTop = down;
    box(0, gdtTop, 38, 7, LAYER_GDT);
    vLine(8, gdtTop, gdtTop + 7, LAYER_GDT);
    vLine(22, gdtTop, gdtTop + 7, LAYER_GDT);
    vLine(30, gdtTop, gdtTop + 7, LAYER_GDT);
    sink.circle(4, Y(gdtTop + 3.5), 4, LAYER_GDT);
    circles += 1;
    hLine(1, 7, gdtTop + 3.5, LAYER_GDT);
    vLine(4, gdtTop + 0.5, gdtTop + 6.5, LAYER_GDT);
    text(`%%c${zoneMm.toFixed(2)}`, 9.5, gdtTop + 4, t.textH - 0.6, LAYER_DIM);
    text('A', 23.5, gdtTop + 4, t.textH - 0.6, LAYER_DIM);
    text('B', 31.5, gdtTop + 4, t.textH - 0.6, LAYER_DIM);
    // 文字在基线之上，NOTE 3 的基线要留出字高再写，避免压住框底。
    down = gdtTop + 7 + t.textH + 1.2;
    text(`NOTE 3: ZONE %%c${zoneMm.toFixed(2)} = 2 x +/-${rules.tolHolePositionMm.toFixed(2)} (INSCRIBED CIRCLE OF +/- SQUARE; CONSERVATIVE)`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;

    // 端面与孔壁的其余形位公差：三框并排，压住版面高度，避免 A4 被迫升 A3。
    const miteredEnds = new Set(miters.map((cut) => cut.end));
    const hasSquareEnd = !miteredEnds.has('start') || !miteredEnds.has('end');
    const squarenessMm = rules.tolEndSquarenessMm;
    const flatnessMm = rules.tolEndFlatnessMm;
    const cylindricityMm = rules.tolHoleCylindricityMm;
    const axisPerpMm = rules.tolHoleAxisPerpMm;
    text(
      hasSquareEnd
        ? 'GD&T (L TO R): END PERP | END FLATNESS | HOLE CYLINDRICITY | HOLE-AXIS PERP'
        : 'GD&T (L TO R): END FLATNESS | HOLE CYLINDRICITY | HOLE-AXIS PERP (END PERP N/A)',
      0,
      down,
      t.textH,
      LAYER_DIM,
    );
    down += t.rowStep - 1;
    const formTop = down;
    let frameX = 0;
    if (hasSquareEnd) {
      box(frameX, formTop, 28, 7, LAYER_GDT);
      vLine(frameX + 8, formTop, formTop + 7, LAYER_GDT);
      vLine(frameX + 20, formTop, formTop + 7, LAYER_GDT);
      // 垂直度符号：横底边 + 竖笔画（⊥）。R12 与 PDF 都没有 GD&T 实体，用线段拼。
      hLine(frameX + 2, frameX + 6, formTop + 5.5, LAYER_GDT);
      vLine(frameX + 4, formTop + 1.5, formTop + 5.5, LAYER_GDT);
      text(squarenessMm.toFixed(2), frameX + 9.5, formTop + 4, t.textH - 0.6, LAYER_DIM);
      text('B', frameX + 21.5, formTop + 4, t.textH - 0.6, LAYER_DIM);
      frameX += 38;
    }
    // 平面度：平行四边形符号 + 公差值，无基准格。
    box(frameX, formTop, 24, 7, LAYER_GDT);
    vLine(frameX + 8, formTop, formTop + 7, LAYER_GDT);
    sink.line(frameX + 1.5, Y(formTop + 5.5), frameX + 5.5, Y(formTop + 5.5), LAYER_GDT);
    sink.line(frameX + 5.5, Y(formTop + 5.5), frameX + 6.5, Y(formTop + 1.5), LAYER_GDT);
    sink.line(frameX + 6.5, Y(formTop + 1.5), frameX + 2.5, Y(formTop + 1.5), LAYER_GDT);
    sink.line(frameX + 2.5, Y(formTop + 1.5), frameX + 1.5, Y(formTop + 5.5), LAYER_GDT);
    text(flatnessMm.toFixed(2), frameX + 9.5, formTop + 4, t.textH - 0.6, LAYER_DIM);
    frameX += 34;
    // 圆柱度：圆加两条平行切线 + 公差值，无基准格。
    box(frameX, formTop, 32, 7, LAYER_GDT);
    vLine(frameX + 10, formTop, formTop + 7, LAYER_GDT);
    sink.circle(frameX + 5, Y(formTop + 3.5), 4, LAYER_GDT);
    circles += 1;
    hLine(frameX + 2.5, frameX + 7.5, formTop + 1.5, LAYER_GDT);
    hLine(frameX + 2.5, frameX + 7.5, formTop + 5.5, LAYER_GDT);
    text(cylindricityMm.toFixed(2), frameX + 11.5, formTop + 4, t.textH - 0.6, LAYER_DIM);
    frameX += 42;
    // 孔轴线对基准 B 的垂直度：符号格 + 公差格 + 基准 B。
    box(frameX, formTop, 28, 7, LAYER_GDT);
    vLine(frameX + 8, formTop, formTop + 7, LAYER_GDT);
    vLine(frameX + 20, formTop, formTop + 7, LAYER_GDT);
    hLine(frameX + 2, frameX + 6, formTop + 5.5, LAYER_GDT);
    vLine(frameX + 4, formTop + 1.5, formTop + 5.5, LAYER_GDT);
    text(axisPerpMm.toFixed(2), frameX + 9.5, formTop + 4, t.textH - 0.6, LAYER_DIM);
    text('B', frameX + 21.5, formTop + 4, t.textH - 0.6, LAYER_DIM);
    down = formTop + 7 + t.textH + 1.2;
    text(
      hasSquareEnd
        ? `NOTE 4: SQUARE-CUT END FACE PERPENDICULAR TO DATUM B WITHIN ${squarenessMm.toFixed(2)} (ENGINEERING PRACTICE, NOT A STANDARD CLAUSE)`
        : `NOTE 4: BOTH ENDS MITERED; END-FACE PERPENDICULARITY N/A, SEE MITER ANGLE TOL +/-${rules.tolAngleDeg.toFixed(1)}`,
      0,
      down,
      t.textH,
      LAYER_DIM,
    );
    down += t.rowStep;
    text(`NOTE 5: END FACE FLATNESS ${flatnessMm.toFixed(2)} (NO DATUM); HOLE WALL CYLINDRICITY ${cylindricityMm.toFixed(2)} (NO DATUM; ENGINEERING PRACTICE, NOT A STANDARD CLAUSE)`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    text(`NOTE 6: EXTRUSION STRAIGHTNESS AND AS-EXTRUDED SURFACE ARE SUPPLIER'S, NOT COVERED BY THIS DRAWING`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    text(`NOTE 7: HOLE AXES PERPENDICULAR TO DATUM B WITHIN ${axisPerpMm.toFixed(2)} (ENGINEERING PRACTICE); COAXIALITY N/A FOR INDEPENDENT CLEARANCE HOLES`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;

    // 表面粗糙度：ISO 1302 风格勾形符号（线段拼，非标准符号实体），数值在右侧。
    const raUm = rules.surfaceRoughnessRaUm;
    const roughTop = down + 1;
    sink.line(2, Y(roughTop + 1), 4.5, Y(roughTop + 3.4), LAYER_GDT);
    sink.line(4.5, Y(roughTop + 3.4), 11, Y(roughTop + 0.2), LAYER_GDT);
    text(`Ra ${raUm} - SURFACE FINISH, MACHINED FACES ONLY (SYMBOL STYLIZED)`, 13, roughTop + 2.4, t.textH, LAYER_DIM);
    down += t.rowStep + 2;
    text(`SURFACE FINISH SRC: ${roughnessSource}`, 0, down, t.textH, LAYER_DIM);
    down += t.rowStep;
    down += t.tableHead;

    text('HOLE     FACE     X(mm)      DIA   DRILL  DEPTH   SERIES  AXIS   POS-TOL', 0, down, t.textH, LAYER_TEXT);
    down += t.tableRow;

    holes.forEach((hole, i) => {
      const holeLabel = `${memberLabel}-H${i + 1}`;
      const along = alongBarMm(hole, length);
      const inBar = along !== null && along >= 0 && along <= length;
      const isTopFace = hole.face === 'top' || hole.face === 'bottom';
      const across = isTopFace ? hole.localU : hole.localV;

      holeLegend.push({
        label: holeLabel,
        memberLabel,
        memberId: member.id,
        face: hole.face,
        at: hole.at,
        alongBarMm: along,
        diameterMm: hole.diameterMm,
        clearanceDrillMm: hole.clearanceDrillMm,
        tapDrillMm: hole.tapDrillMm,
        depthMm: hole.depthMm,
        boltSeries: hole.boltSeries,
        boltAxis: hole.boltAxis,
        inBar,
      });

      const drillCell = hole.clearanceDrillMm === null ? 'TBD' : hole.clearanceDrillMm.toFixed(1);
      const travel = isTopFace ? height : width;
      const depthCell = hole.depthMm === null ? `THRU(${travel.toFixed(1)})` : hole.depthMm.toFixed(1);
      text(
        `${holeLabel.padEnd(8)} ${hole.face.toUpperCase().padEnd(8)} ${num(along).padStart(8)}  ${num(hole.diameterMm).padStart(5)}  ${drillCell.padStart(5)}  ${depthCell.padStart(6)}  ${hole.boltSeries.padEnd(6)} ${hole.boltAxis.toUpperCase().padEnd(5)} +/-${rules.tolHolePositionMm.toFixed(2)}`,
        0,
        down,
        t.textH,
        LAYER_TEXT,
      );
      down += t.tableRow;

      if (!inBar) {
        warnings.push(`${holeLabel}（杆件 ${member.id}）孔位 ${num(along)} mm 超出杆身 0..${num(length)} mm，未画入视图`);
        return;
      }
      if (hole.diameterMm === null) {
        warnings.push(`${holeLabel} 无公称直径（系列 ${hole.boltSeries} 未解析），只列表未画圆`);
        return;
      }

      const viewAt = isTopFace ? topViewAt : sideViewAt;
      const viewSize = isTopFace ? viewWidth : viewHeight;
      const cx = along * scale;
      const cyDown = viewAt + viewSize / 2 + across * scale;
      const holeDiameterMm = hole.diameterMm * scale;
      sink.circle(cx, Y(cyDown), holeDiameterMm, layer);
      vLine(cx, viewAt + 1, viewAt + viewSize - 1, LAYER_CENTER);
      // 标签避让：与已有标签横向 12mm 且纵向 3.5mm 内重叠时省略，孔位表为准。
      const labelX = cx + 1.5;
      const labelY = cyDown - holeDiameterMm / 2 - t.textH;
      const collides = labelSlots.some((s) => Math.abs(s.x - labelX) < 12 && Math.abs(s.y - labelY) < 3.5);
      if (collides) {
        skippedLabels += 1;
      } else {
        labelSlots.push({ x: labelX, y: labelY });
        text(holeLabel, labelX, labelY, t.textH, LAYER_TEXT);
      }
      circles += 1;
    });

    for (const cap of (plan.endCaps ?? []).filter((c) => c.memberId === member.id)) {
      const at = cap.end === 'end' ? viewLength : 0;
      text(`END CAP ${cap.widthMm.toFixed(0)}x${cap.heightMm.toFixed(0)} AT ${cap.end.toUpperCase()}`, 0, down, t.textH, LAYER_DIM);
      vLine(at, topViewAt - 3, topViewAt + viewWidth + 3, LAYER_DIM);
      down += t.tableRow;
    }

    sink.endBlock(index);
    blocks.push({
      memberIndex: index,
      memberLabel,
      memberId: member.id,
      topMm: blockTop,
      bottomMm: originY - down,
      heightMm: down,
      scale,
    });
    originY -= down + t.blockTail + gapMm;
  });

  if (model.members.length === 0) {
    sink.beginBlock(0, 'M1');
    texts += 1;
    sink.text('NO MEMBERS', 0, 0, t.titleH, LAYER_TEXT);
    sink.endBlock(0);
  }

  if (skippedLabels > 0) {
    warnings.push(`${skippedLabels} 个孔位标签因与已有标签重叠未画出，以孔位表为准`);
  }

  return {
    memberLegend,
    holeLegend,
    warnings,
    toleranceNote,
    drillSource,
    roughnessSource,
    endSquarenessMm: rules.tolEndSquarenessMm,
    endFlatnessMm: rules.tolEndFlatnessMm,
    holeCylindricityMm: rules.tolHoleCylindricityMm,
    holeAxisPerpMm: rules.tolHoleAxisPerpMm,
    surfaceRoughnessRaUm: rules.surfaceRoughnessRaUm,
    positionZoneMm: 2 * rules.tolHolePositionMm,
    blocks,
    stats: { members: model.members.length, holes: holeLegend.length, circles, texts },
  };
}
