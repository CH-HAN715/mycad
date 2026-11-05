import type { SectionProperties } from '../geom/inertia.ts';
import { SECTION_PROVENANCE, sig } from '../geom/inertia.ts';
import type { ProfileMeta, ProfileSpec } from '../geom/profile.ts';
import { PROFILE_PROVENANCE } from '../geom/profile.ts';
import { TOL } from '../geom/tolerance.ts';
import { UNIT_SCHEMA } from '../geom/units.ts';

/**
 * 截面报告：把「公式 + 输入 + 单位 + 假设 + 局限 + 免责」和结果放进同一份产物。
 * 只做已算出的几何量的呈现，不引入新的计算，也不做任何标准符合性声明。
 */

export interface SectionReportInput {
  readonly source: string;
  readonly version: string;
  readonly properties: SectionProperties;
  readonly profile?: {
    readonly spec: ProfileSpec;
    readonly meta: ProfileMeta;
  };
}

export interface SectionReport {
  readonly source: string;
  readonly version: string;
  readonly method: string;
  readonly exactForPolygon: boolean;
  readonly units: typeof UNIT_SCHEMA;
  readonly result: Record<string, unknown>;
  readonly validation: typeof SECTION_PROVENANCE.validation;
  readonly profile:
    | {
        readonly spec: ProfileSpec;
        readonly meta: ProfileMeta;
        readonly provenance: typeof PROFILE_PROVENANCE;
      }
    | null;
  readonly formulas: readonly string[];
  readonly assumptions: readonly string[];
  readonly limitations: readonly string[];
  readonly disclaimer: string;
}

/** 显示层噪声清理：小于重合容差的量按 0 输出。 */
const denoise = (v: number): number => (Math.abs(v) < TOL.coincide ? 0 : v);
const num = (v: number): number => sig(denoise(v), TOL.outputSignificant);

/** 结果数值的规范化 JSON 形式，供 CLI 与报告共用，避免两处各写一份序列化。 */
export function serializeSectionValues(s: SectionProperties): Record<string, unknown> {
  return {
    area: num(s.area),
    centroid: { x: num(s.centroid.x), y: num(s.centroid.y) },
    ix: num(s.ix),
    iy: num(s.iy),
    ixy: num(s.ixy),
    principal: {
      imax: num(s.principal.imax),
      imin: num(s.principal.imin),
      thetaDeg: num(s.principal.thetaDeg),
      radiusMax: num(s.principal.radiusMax),
      radiusMin: num(s.principal.radiusMin),
    },
    modulus: {
      wxTop: num(s.modulus.wxTop),
      wxBottom: num(s.modulus.wxBottom),
      wyLeft: num(s.modulus.wyLeft),
      wyRight: num(s.modulus.wyRight),
    },
    extremes: {
      yTop: num(s.extremes.yTop),
      yBottom: num(s.extremes.yBottom),
      xLeft: num(s.extremes.xLeft),
      xRight: num(s.extremes.xRight),
    },
    bbox: {
      xMin: num(s.bbox.xMin),
      xMax: num(s.bbox.xMax),
      yMin: num(s.bbox.yMin),
      yMax: num(s.bbox.yMax),
    },
  };
}

export function buildSectionReport(input: SectionReportInput): SectionReport {
  return {
    source: input.source,
    version: input.version,
    method: SECTION_PROVENANCE.method,
    exactForPolygon: SECTION_PROVENANCE.exactForPolygon,
    units: UNIT_SCHEMA,
    result: serializeSectionValues(input.properties),
    validation: SECTION_PROVENANCE.validation,
    profile:
      input.profile === undefined
        ? null
        : { spec: input.profile.spec, meta: input.profile.meta, provenance: PROFILE_PROVENANCE },
    formulas: SECTION_PROVENANCE.formulas,
    assumptions: SECTION_PROVENANCE.assumptions,
    limitations: SECTION_PROVENANCE.limitations,
    disclaimer: SECTION_PROVENANCE.disclaimer,
  };
}

const cell = (v: unknown): string => String(v);

function resultRows(report: SectionReport): readonly (readonly [string, string, string])[] {
  const r = report.result as {
    area: number;
    centroid: { x: number; y: number };
    ix: number;
    iy: number;
    ixy: number;
    principal: { imax: number; imin: number; thetaDeg: number; radiusMax: number; radiusMin: number };
    modulus: { wxTop: number; wxBottom: number; wyLeft: number; wyRight: number };
    bbox: { xMin: number; xMax: number; yMin: number; yMax: number };
  };
  const isotropic = Math.abs(r.principal.imax - r.principal.imin) <= TOL.relVerify * Math.max(r.principal.imax, 1);
  const theta = isotropic ? '任意（imax ≈ imin）' : `${r.principal.thetaDeg} deg`;
  return [
    ['面积 A', cell(r.area), 'mm^2'],
    ['形心 x', cell(r.centroid.x), 'mm'],
    ['形心 y', cell(r.centroid.y), 'mm'],
    ['Ix', cell(r.ix), 'mm^4'],
    ['Iy', cell(r.iy), 'mm^4'],
    ['Ixy', cell(r.ixy), 'mm^4'],
    ['主轴 imax', cell(r.principal.imax), 'mm^4'],
    ['主轴 imin', cell(r.principal.imin), 'mm^4'],
    ['主轴角 θ', theta, '—'],
    ['回转半径 imax', cell(r.principal.radiusMax), 'mm'],
    ['回转半径 imin', cell(r.principal.radiusMin), 'mm'],
    ['Wx 上', cell(r.modulus.wxTop), 'mm^3'],
    ['Wx 下', cell(r.modulus.wxBottom), 'mm^3'],
    ['Wy 左', cell(r.modulus.wyLeft), 'mm^3'],
    ['Wy 右', cell(r.modulus.wyRight), 'mm^3'],
    ['包围盒 x', `[${r.bbox.xMin}, ${r.bbox.xMax}]`, 'mm'],
    ['包围盒 y', `[${r.bbox.yMin}, ${r.bbox.yMax}]`, 'mm'],
  ];
}

export function renderSectionReportMarkdown(report: SectionReport): string {
  const lines: string[] = [];
  lines.push('# 截面特性报告', '');
  lines.push(`- 输入来源：${report.source}`);
  lines.push(`- 引擎版本：mycad ${report.version}`);
  lines.push(`- 计算方法：${report.method}${report.exactForPolygon ? '（对多边形为精确解，非拟合）' : ''}`);
  lines.push('- 单位：mm / mm^2 / mm^4 / mm^3 / deg');
  lines.push('');

  lines.push('## 结果', '');
  lines.push('| 项目 | 数值 | 单位 |');
  lines.push('| --- | --- | --- |');
  for (const [name, value, unit] of resultRows(report)) lines.push(`| ${name} | ${value} | ${unit} |`);
  lines.push('');

  if (report.profile !== null) {
    const { spec, meta, provenance } = report.profile;
    lines.push('## 型材模型', '');
    lines.push(`- 外框：${spec.width} × ${spec.height} mm`);
    lines.push(
      `- T 槽：${meta.slotCount} 个（${meta.slotFaces.join('、')}），` +
        `开口 ${spec.slot?.opening ?? 0} / 深 ${spec.slot?.depth ?? 0} / T 头 ${spec.slot?.headWidth ?? 0} mm`,
    );
    lines.push(`- 中心孔：${meta.boreSegments} 边形，r=${meta.boreRadius} mm，A=${num(meta.boreArea)} mm^2`);
    lines.push(`- 未建模：${provenance.notModeled.join('、')}`);
    lines.push('');
  }

  lines.push('## 校验状态', '');
  lines.push(`- 自交轮廓：${report.validation.selfIntersection === 'rejected' ? '拒绝（不允许静默计算）' : report.validation.selfIntersection}`);
  lines.push(`- 孔洞拓扑：${report.validation.holeTopology === 'rejected' ? '拒绝（越界、重叠、嵌套均报错）' : report.validation.holeTopology}`);
  lines.push(`- 单轮廓顶点上限：${report.validation.maxVerticesPerContour}`);
  lines.push(`- 积分原点：${report.validation.originShift === 'bbox_center' ? '包围盒中心（避免大坐标抵消）' : report.validation.originShift}`);
  lines.push('');

  lines.push('## 公式', '');
  for (const formula of report.formulas) lines.push(`- \`${formula}\``);
  lines.push('');

  lines.push('## 假设', '');
  for (const assumption of report.assumptions) lines.push(`- ${assumption}`);
  lines.push('');

  lines.push('## 局限', '');
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push('');

  lines.push('## 免责', '');
  lines.push(`> ${report.disclaimer}`, '');
  return lines.join('\n');
}
