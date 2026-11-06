import type { Vec2 } from '../geom/polygon.ts';

/**
 * L7 输出层：截面 DXF（AC1009 / R12，LINE + CIRCLE 实体）。
 *
 * 输出外轮廓与孔洞的闭合线段、可选的圆孔（圆心+直径），以及毫米单位声明。
 * 不含尺寸标注、公差、孔位表的深度/螺纹与加工特征——这些必须由后续图层补齐，
 * 本文件不能直接充当可加工图纸。
 */

export const DXF_PROVENANCE = {
  format: 'AC1009 (R12)',
  entities: ['LINE', 'CIRCLE'],
  units: 'mm',
  limitations: [
    '只有轮廓线段与圆孔，没有尺寸标注、公差与加工工艺',
    '孔洞按闭合多段线输出，圆孔只含圆心与直径，不含深度、螺纹与孔位公差',
    '不输出图层以外的元数据，也不含材料与表面处理',
  ],
  disclaimer: 'DXF 仅为几何轮廓交换文件，不是可加工图纸；下厂前必须补齐尺寸、公差与工艺要求。',
} as const;

/** 圆孔：圆心与直径，用于端面孔位图。 */
export interface CircleSpec {
  readonly center: Vec2;
  readonly diameterMm: number;
}

export interface DxfOptions {
  readonly layer?: string;
  readonly circles?: readonly CircleSpec[];
}

const formatNumber = (value: number): string => {
  const fixed = value.toFixed(6);
  return fixed.replace(/\.?0+$/, '') || '0';
};

/** R12 文档骨架：HEADER（单位 mm）+ ENTITIES + EOF。 */
export function dxfDocument(entities: readonly string[]): string {
  return [
    '0',
    'SECTION',
    '2',
    'HEADER',
    '9',
    '$ACADVER',
    '1',
    'AC1009',
    '9',
    '$INSUNITS',
    '70',
    '4',
    '0',
    'ENDSEC',
    '0',
    'SECTION',
    '2',
    'ENTITIES',
    ...entities,
    '0',
    'ENDSEC',
    '0',
    'EOF',
    '',
  ].join('\n');
}

export function lineEntity(x1: number, y1: number, x2: number, y2: number, layer: string): string {
  return [
    '0',
    'LINE',
    '8',
    layer,
    '10',
    formatNumber(x1),
    '20',
    formatNumber(y1),
    '30',
    '0',
    '11',
    formatNumber(x2),
    '21',
    formatNumber(y2),
    '31',
    '0',
  ].join('\n');
}

/** 单行文本；R12 的 group 1 必须在 40/50 之后，且不接受换行。 */
export function textEntity(
  value: string,
  x: number,
  y: number,
  height: number,
  layer: string,
): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new RangeError('DXF TEXT 不能包含换行');
  }
  return [
    '0',
    'TEXT',
    '8',
    layer,
    '10',
    formatNumber(x),
    '20',
    formatNumber(y),
    '30',
    '0',
    '40',
    formatNumber(height),
    '50',
    '0',
    '1',
    value,
  ].join('\n');
}

function contourEntities(contour: readonly Vec2[], layer: string): string[] {
  const entities: string[] = [];
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    entities.push(lineEntity(a.x, a.y, b.x, b.y, layer));
  }
  return entities;
}

export function circleEntity(center: Vec2, diameterMm: number, layer: string): string {
  return [
    '0',
    'CIRCLE',
    '8',
    layer,
    '10',
    formatNumber(center.x),
    '20',
    formatNumber(center.y),
    '30',
    '0',
    '40',
    formatNumber(diameterMm / 2),
  ].join('\n');
}

export function sectionToDxf(
  outer: readonly Vec2[],
  holes: readonly (readonly Vec2[])[] = [],
  options: DxfOptions = {},
): string {
  if (outer.length < 3) throw new RangeError(`外轮廓至少需要 3 个点，收到 ${outer.length}`);
  for (const contour of [outer, ...holes]) {
    for (const point of contour) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new RangeError('DXF 坐标必须是有限数');
      }
    }
  }
  const circles = options.circles ?? [];
  for (const circle of circles) {
    if (!Number.isFinite(circle.center.x) || !Number.isFinite(circle.center.y)) {
      throw new RangeError('DXF 圆心坐标必须是有限数');
    }
    if (!Number.isFinite(circle.diameterMm) || circle.diameterMm <= 0) {
      throw new RangeError(`DXF 圆孔直径必须为正数，收到 ${circle.diameterMm}`);
    }
  }

  const layer = options.layer ?? 'MYCAD';
  if (!/^[A-Za-z0-9_\-]+$/.test(layer)) {
    throw new RangeError(`图层名只允许字母、数字、下划线与连字符：${layer}`);
  }

  const entities = [
    ...contourEntities(outer, layer),
    ...holes.flatMap((hole) => contourEntities(hole, layer)),
    ...circles.map((circle) => circleEntity(circle.center, circle.diameterMm, layer)),
  ];

  return dxfDocument(entities);
}
