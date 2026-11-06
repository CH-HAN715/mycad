import type { FrameModel } from '../frame/model.ts';
import type { ConnectPlan, ConnectorHole, MiterCut } from '../connect/plan.ts';
import { circleEntity, dxfDocument, lineEntity, textEntity } from './dxf.ts';
import { U } from '../geom/units.ts';

/**
 * L7 输出层：杆件孔位图（每根杆一块，纵向堆叠在同一 DXF 内）。
 *
 * 分工：`dxf.ts` 画截面轮廓，本文件画**成品杆件**的长度、顶面/侧面视图与孔位表。
 * 两者都不带公差与工艺，不是可签收的下厂图纸，边界见 MEMBER_DXF_PROVENANCE。
 */

export const MEMBER_DXF_PROVENANCE = {
  format: 'AC1009 (R12)',
  entities: ['LINE', 'CIRCLE', 'TEXT'],
  units: 'mm',
  datum:
    '每根杆件的 x=0 取 start 端下料后的物理端面，x 增大指向 end 端；孔位为距该端面的距离',
  views: [
    '顶面视图（TOP VIEW）：承载 top/bottom 面的孔，横向为截面局部 u',
    '侧面视图（SIDE VIEW）：承载 left/right 面的孔，横向为截面局部 v',
  ],
  viewAxisNote:
    '视图内横向坐标 = 截面局部坐标（形心基准），绘制时正方向朝图纸下方；与 CONNECT_PROVENANCE.sectionFrameConvention 同源',
  assumptions: [
    '孔位来自 L3 规则引擎的角件近似（端距 + 等间距展开），不是零件厂商的实际孔型',
    '未启用 trim 时 cutLength 等于中心线长；启用后孔位仍按物理端面起算',
    '螺栓孔按公称直径画圆，钻孔直径按规则的 ISO 273 中系列公开表另列一栏，不画沉孔与锪面',
    '一期所有孔按通孔输出（DEPTH=THRU），不做盲孔与攻丝深度决策',
  ],
  limitations: [
    '一般公差只给注记量级（类比公开 ISO 2768 表），不含逐尺寸公差带、形位公差与表面粗糙度',
    '不使用 DIMENSION 实体，尺寸以线段加文本近似，CAD 内取值须以文本为准',
    'DXF 内只用 ASCII 标签（M1/M1-H1），杆件原名只出现在返回的 legend 里，避免 R12 中文编码歧义',
    'T 接侧面孔按槽面螺栓近似，实物角件必须复核',
    '斜切只画切割平面轨迹与长短点尺寸；长点位于哪一侧由装配方向决定，须对照 3D 模型确认',
  ],
  disclaimer:
    '本图是孔位与长度的加工参考图，不是可签收的下厂图纸；投产前必须补齐公差、孔深与工艺，并由工程师确认。',
} as const;

export interface MemberDrawingOptions {
  readonly layer?: string;
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

export interface MemberDrawingResult {
  readonly dxf: string;
  readonly memberLegend: readonly MemberLegendRow[];
  readonly holeLegend: readonly HoleLegendRow[];
  readonly warnings: readonly string[];
  /** 图纸上实际写出的公差注记（已保证 ASCII）。 */
  readonly toleranceNote: string;
  /** 钻孔直径表来源，随规则覆盖变化。 */
  readonly drillSource: string;
  readonly stats: {
    readonly members: number;
    readonly holes: number;
    readonly circles: number;
    readonly texts: number;
  };
}

/** DXF 正文必须是 ASCII：用户覆盖的注记含中文时降级并告警，不写进图。 */
function asciiOnly(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, '');
}

const LAYER_CENTER = 'CENTER';
const LAYER_TEXT = 'TEXT';
const LAYER_DIM = 'DIM';
/** 图纸排版常量，mm：不参与任何工程计算。 */
const TITLE_ROW = 8;
const VIEW_PAD = 16;
const VIEW_GAP = 14;
const DIM_ROW = 14;
const TABLE_HEAD = 12;
const TABLE_ROW = 7;
const BLOCK_TAIL = 26;
const MEMBER_GAP = 34;
const TEXT_H = 3.2;
const TITLE_H = 4.5;

/** 孔在杆件轴上的位置：start 端从 0 起算，end 端从 cutLength 倒推。 */
function alongBarMm(hole: ConnectorHole, cutLength: number): number | null {
  if (hole.at === 'interior') return hole.alongStartMm;
  if (hole.fromJointEndMm === null) return null;
  return hole.at === 'start' ? hole.fromJointEndMm : cutLength - hole.fromJointEndMm;
}

const num = (value: number | null): string => (value === null ? '-' : value.toFixed(2));

export function memberDrawingsToDxf(
  model: FrameModel,
  plan: ConnectPlan,
  options: MemberDrawingOptions = {},
): MemberDrawingResult {
  const layer = options.layer ?? 'MYCAD';
  if (!/^[A-Za-z0-9_\-]+$/.test(layer)) {
    throw new RangeError(`图层名只允许字母、数字、下划线与连字符：${layer}`);
  }
  const rawNote = plan.rules.generalToleranceNote;
  const rawDrill = plan.rules.drillTableSource;
  const toleranceNote = asciiOnly(rawNote) || 'GENERAL TOL NOT STATED (SEE LEGEND)';
  const drillSource = asciiOnly(rawDrill) || 'DRILL TABLE OVERRIDDEN (SOURCE NON-ASCII, SEE LEGEND)';
  const warnings: string[] = [];
  if (asciiOnly(rawNote).length !== rawNote.length || asciiOnly(rawDrill).length !== rawDrill.length) {
    warnings.push('generalToleranceNote 或 drillTableSource 含非 ASCII 字符，已从 DXF 正文剔除，原文见返回字段与 legend');
  }

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

  const entities: string[] = [];
  const memberLegend: MemberLegendRow[] = [];
  const holeLegend: HoleLegendRow[] = [];
  let circles = 0;
  let texts = 0;
  /** 当前块原点的图纸 y（DXF y 向上），每块向下推进。 */
  let originY = 0;

  model.members.forEach((member, index) => {
    const profile = model.profiles.find((p) => p.id === member.profileId);
    const width = profile !== undefined ? profile.spec.width : 20;
    const height = profile !== undefined ? profile.spec.height : 20;
    const length = member.cutLength;
    const memberLabel = `M${index + 1}`;
    const holes = holesByMember.get(member.id) ?? [];

    memberLegend.push({
      label: memberLabel,
      memberId: member.id,
      profileId: member.profileId,
      cutLengthMm: length,
      trimStartMm: member.trimStart,
      trimEndMm: member.trimEnd,
      materialName: profile?.material?.name ?? null,
    });

    // 局部坐标用「y 向下」书写，落笔时统一翻到图纸坐标，避免正负号在脑子里换算。
    const Y = (down: number): number => originY - down;
    const hLine = (x1: number, x2: number, down: number, lyr: string): string =>
      lineEntity(x1, Y(down), x2, Y(down), lyr);
    const vLine = (x: number, d1: number, d2: number, lyr: string): string =>
      lineEntity(x, Y(d1), x, Y(d2), lyr);
    const box = (x: number, top: number, w: number, h: number, lyr: string): string[] => [
      hLine(x, x + w, top, lyr),
      hLine(x, x + w, top + h, lyr),
      vLine(x, top, top + h, lyr),
      vLine(x + w, top, top + h, lyr),
    ];
    const text = (value: string, x: number, down: number, h: number, lyr: string): string => {
      texts += 1;
      return textEntity(value, x, Y(down), h, lyr);
    };

    let down = 0;
    entities.push(text(`${memberLabel}  CUT=${num(length)}  SECTION=${num(width)}x${num(height)}`, 0, down, TITLE_H, LAYER_TEXT));
    down += TITLE_ROW;
    entities.push(
      text(`TRIM ${num(member.trimStart)} / ${num(member.trimEnd)}   DATUM: START FACE, x=0   HOLES: ${holes.length}`, 0, down, TEXT_H, LAYER_TEXT),
    );
    down += TITLE_ROW;

    const topViewAt = down;
    entities.push(...box(0, topViewAt, length, width, layer));
    entities.push(hLine(0, length, topViewAt + width / 2, LAYER_CENTER));
    entities.push(text('TOP VIEW', length + 6, topViewAt, TEXT_H, LAYER_TEXT));
    down = topViewAt + width + VIEW_GAP;

    const sideViewAt = down;
    entities.push(...box(0, sideViewAt, length, height, layer));
    entities.push(hLine(0, length, sideViewAt + height / 2, LAYER_CENTER));
    entities.push(text('SIDE VIEW', length + 6, sideViewAt, TEXT_H, LAYER_TEXT));
    down = sideViewAt + height + DIM_ROW;

    for (const cut of mitersByMember.get(member.id) ?? []) {
      const half = (cut.longPointMm - cut.shortPointMm) / 2;
      const at = cut.end === 'end' ? length : 0;
      const viewAt = cut.view === 'top' ? topViewAt : sideViewAt;
      const viewSize = cut.view === 'top' ? width : height;
      entities.push(
        lineEntity(at - half, Y(viewAt), at + half, Y(viewAt + viewSize), LAYER_DIM),
      );
      entities.push(
        text(
          `MITER ${cut.angleDeg} AT ${cut.end.toUpperCase()} LONG=${num(cut.longPointMm)} SHORT=${num(cut.shortPointMm)} VIEW=${cut.view.toUpperCase()}`,
          0,
          down,
          TEXT_H,
          LAYER_DIM,
        ),
      );
      down += 5;
    }

    const miters = mitersByMember.get(member.id) ?? [];
    let stockLength: number = length;
    for (const cut of miters) stockLength += (cut.longPointMm - cut.shortPointMm) / 2;

    entities.push(hLine(0, length, down, LAYER_DIM));
    entities.push(vLine(0, down - 3, down + 3, LAYER_DIM));
    entities.push(vLine(length, down - 3, down + 3, LAYER_DIM));
    down += 4;
    entities.push(
      text(
        miters.length === 0
          ? `CUT LENGTH ${num(length)} mm`
          : `CUT LENGTH ${num(stockLength)} mm (STOCK)  CENTERLINE ${num(length)} mm  MITER ALLOWANCE ${num(stockLength - length)} mm`,
        0,
        down,
        TEXT_H,
        LAYER_DIM,
      ),
    );
    down += 5;
    entities.push(text(toleranceNote, 0, down, TEXT_H, LAYER_DIM));
    down += 5;
    entities.push(text(`DRILL TABLE: ${drillSource}`, 0, down, TEXT_H, LAYER_DIM));
    down += TABLE_HEAD;

    entities.push(
      text('HOLE     FACE     X(mm)      DIA   DRILL  DEPTH   SERIES  AXIS', 0, down, TEXT_H, LAYER_TEXT),
    );
    down += TABLE_ROW;

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
      const depthCell = hole.depthMm === null ? 'THRU' : hole.depthMm.toFixed(1);
      entities.push(
        text(
          `${holeLabel.padEnd(8)} ${hole.face.toUpperCase().padEnd(8)} ${num(along).padStart(8)}  ${num(hole.diameterMm).padStart(5)}  ${drillCell.padStart(5)}  ${depthCell.padStart(6)}  ${hole.boltSeries.padEnd(6)} ${hole.boltAxis.toUpperCase()}`,
          0,
          down,
          TEXT_H,
          LAYER_TEXT,
        ),
      );
      down += TABLE_ROW;

      if (!inBar) {
        warnings.push(`${holeLabel}（杆件 ${member.id}）孔位 ${num(along)} mm 超出杆身 0..${num(length)} mm，未画入视图`);
        return;
      }
      if (hole.diameterMm === null) {
        warnings.push(`${holeLabel} 无公称直径（系列 ${hole.boltSeries} 未解析），只列表未画圆`);
        return;
      }

      const viewAt = isTopFace ? topViewAt : sideViewAt;
      const viewSize = isTopFace ? width : height;
      const cx = along;
      const cyDown = viewAt + viewSize / 2 + across;
      entities.push(circleEntity({ x: U.mm(cx), y: U.mm(Y(cyDown)) }, hole.diameterMm, layer));
      entities.push(vLine(cx, viewAt + 1, viewAt + viewSize - 1, LAYER_CENTER));
      entities.push(text(holeLabel, cx + 1.5, cyDown - hole.diameterMm / 2 - TEXT_H, TEXT_H, LAYER_TEXT));
      circles += 1;
    });

    originY -= down + BLOCK_TAIL + MEMBER_GAP;
  });

  if (model.members.length === 0) {
    entities.push(textEntity('NO MEMBERS', 0, 0, TITLE_H, LAYER_TEXT));
    texts += 1;
  }

  return {
    dxf: dxfDocument(entities),
    memberLegend,
    holeLegend,
    warnings,
    toleranceNote,
    drillSource,
    stats: { members: model.members.length, holes: holeLegend.length, circles, texts },
  };
}
