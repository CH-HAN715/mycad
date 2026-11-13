import type { FrameModel } from '../frame/model.ts';
import type { ConnectPlan } from '../connect/plan.ts';
import { circleEntity, dxfDocument, lineEntity, textEntity } from './dxf.ts';
import { U } from '../geom/units.ts';
import { layoutMemberDrawings } from './drawingLayout.ts';
import type { DrawingSink } from './drawingLayout.ts';
import type { HoleLegendRow, MemberLegendRow } from './drawingLayout.ts';

/**
 * L7 输出层：杆件孔位图（每根杆一块，纵向堆叠在同一 DXF 内）。
 *
 * 排版在 drawingLayout.ts，本文件只把图元写成 DXF 实体；
 * PDF 输出复用同一份排版，见 memberPdf.ts。
 */

export const MEMBER_DXF_PROVENANCE = {
  format: 'AC1009 (R12)',
  entities: ['LINE', 'CIRCLE', 'TEXT'],
  units: 'mm',
  datum:
    'datum A 取每根杆件 start 端下料后的物理端面（x=0），x 增大指向 end 端，孔位 X 均以 A 起算；datum B 取各视图的截面中心线，横向孔位均以 B 起算',
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
    '所有孔按通光通孔输出（CLR-THRU）；孔深列给出最小钻穿行程，顶/底面孔取截面高度、左/右面孔取宽度；不在本件攻丝，螺纹规格只约束配对槽螺母/嵌件',
    '位置度区取孔位公差 ± 方差的保守内接圆：zone = 2 × tolHolePositionMm，放弃四角、面积保留 78.5%；若工艺单给的是直径区，应把 tolHolePositionMm 设为该直径的一半',
    '方切端面按垂直度框（⊥ 0.20 对基准 B）输出，数值来自 tolEndSquarenessMm；两端均斜切时不出框，只保留斜切角度公差',
    '端面平面度与孔壁圆柱度各出一框（无基准引用），数值来自 tolEndFlatnessMm / tolHoleCylindricityMm；型材直线度与挤出面状态归供应商，图内只注明不覆盖',
    '孔轴线按对基准 B 的垂直度框输出，数值来自 tolHoleAxisPerpMm；同轴度不适用于相互独立的通光孔（没有公共基准轴线），图内注明不适用',
    '表面粗糙度以勾形符号加 Ra 数值给出（符号为线段拼的近似，非标准符号实体）；Ra 与来源由 surfaceRoughnessRaUm / roughnessSource 控制，型材挤出面与锯切端面不在其覆盖范围',
  ],
  limitations: [
    '一般公差为注记量级（类比公开 ISO 2768 表）；逐尺寸公差带已给长度/孔位/孔深/角度，位置度、端面垂直度、端面平面度、孔壁圆柱度与孔轴垂直度以图形化符号框给出，表面粗糙度以 Ra 注记给出；仍不含独立圆度、线/面轮廓度等其余形位公差',
    '不使用 DIMENSION 实体，尺寸以线段加文本近似，CAD 内取值须以文本为准',
    'DXF 内只用 ASCII 标签（M1/M1-H1），杆件原名只出现在返回的 legend 里，避免 R12 中文编码歧义',
    'T 接侧面孔按槽面螺栓近似，实物角件必须复核',
    '斜切只画切割平面轨迹与长短点尺寸；长点位于哪一侧由装配方向决定，须对照 3D 模型确认',
  ],
  disclaimer:
    '本图是孔位与长度的加工参考图，不是可签收的下厂图纸；投产前必须补齐其余形位公差，并由工程师确认。',
} as const;

export type { HoleLegendRow, MemberLegendRow } from './drawingLayout.ts';

export interface MemberDrawingOptions {
  readonly layer?: string;
}

export interface MemberDrawingResult {
  readonly dxf: string;
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
  readonly stats: {
    readonly members: number;
    readonly holes: number;
    readonly circles: number;
    readonly texts: number;
  };
}

export function memberDrawingsToDxf(
  model: FrameModel,
  plan: ConnectPlan,
  options: MemberDrawingOptions = {},
): MemberDrawingResult {
  const layer = options.layer ?? 'MYCAD';
  if (!/^[A-Za-z0-9_\-]+$/.test(layer)) {
    throw new RangeError(`图层名只允许字母、数字、下划线与连字符：${layer}`);
  }
  const entities: string[] = [];
  const sink: DrawingSink = {
    beginBlock: () => {},
    line: (x1, y1, x2, y2, lyr) => {
      entities.push(lineEntity(x1, y1, x2, y2, lyr));
    },
    circle: (cx, cy, diameterMm, lyr) => {
      entities.push(circleEntity({ x: U.mm(cx), y: U.mm(cy) }, diameterMm, lyr));
    },
    text: (value, x, y, heightMm, lyr) => {
      entities.push(textEntity(value, x, y, heightMm, lyr));
    },
    endBlock: () => {},
  };
  const layout = layoutMemberDrawings(model, plan, sink, { layer });

  return {
    dxf: dxfDocument(entities),
    memberLegend: layout.memberLegend,
    holeLegend: layout.holeLegend,
    warnings: layout.warnings,
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
