import type { ProfileSpec } from './profile.ts';

/**
 * 内置型材预设：几何参数进 L1 DSL，厂家公布值原样携带（reference）。
 * 尺寸数值取自公开网页/样本（登记于 docs/型材数据源.md），未搬用任何厂商模型或图纸。
 * 直角理想化截面不含空心腔，计算面积/惯性矩系统性偏大，两值必须并列输出、不得混用。
 */

export interface PresetReference {
  readonly massPerMeterKg?: number;
  readonly ixMm4?: number;
  readonly iyMm4?: number;
  readonly zxMm3?: number;
  readonly zyMm3?: number;
  readonly material?: string;
  readonly elasticModulusMPa?: number;
  readonly sourceTitle: string;
  readonly sourceUrl: string;
  readonly checkedAt: string;
}

export interface ProfilePreset {
  readonly id: string;
  readonly title: string;
  readonly spec: ProfileSpec;
  readonly reference?: PresetReference;
  /** 未从公开文本核实、按工程惯例理想化的字段。 */
  readonly unverifiedFields: readonly string[];
  readonly notes: readonly string[];
}

export const PROFILE_PRESETS: readonly ProfilePreset[] = [
  {
    id: 'eu2020',
    title: '欧标 2020（槽宽 6 系列）',
    spec: {
      width: 20,
      height: 20,
      slot: { opening: 6.15, depth: 4.5, headWidth: 9, headStart: 2 },
      bore: { radius: 2.5 },
    },
    reference: {
      massPerMeterKg: 0.43,
      ixMm4: 7200,
      iyMm4: 7200,
      zxMm3: 720,
      zyMm3: 720,
      material: '6063-T5',
      elasticModulusMPa: 70000,
      sourceTitle: '米思米【欧标经济型】槽宽6mm 20系列样本 P1_202005_04（LCF6-2020）',
      sourceUrl: 'https://www.misumi.com.cn/pdf/vona/P1_202005_04.pdf',
      checkedAt: '2026-11-06',
    },
    unverifiedFields: ['slot.depth（来源为单篇网文，需实测）', 'slot.headWidth / headStart（工程惯例理想化）'],
    notes: [
      '槽口 6.1–6.2 取中值 6.15；中心孔 φ5 取自米思马样本图纸标注。',
      '理想化截面不含空心腔：计算面积/惯性矩较厂家值偏大（约 +23% Ix），校核取值优先用 reference。',
    ],
  },
  {
    id: 'eu4040',
    title: '欧标 4040（槽宽 8 系列）',
    spec: {
      width: 40,
      height: 40,
      slot: { opening: 8.2, depth: 10, headWidth: 14, headStart: 3 },
      bore: { radius: 3.4 },
    },
    unverifiedFields: [
      'slot.depth / headWidth / headStart（工程惯例理想化，需实测）',
      '槽口宽：公开来源在 8 / 8.2 / 8.5±0.2 / 10.2 间不一致，取 8.2，采购前按实物核对',
    ],
    notes: [
      '外形 40×40、中心孔 φ6.8、壁厚 1.6/2.3 取自奥宏公开文章（单源，需实测）。',
      '40 系列欧标存在多种槽型并行，不同厂家配件不通用。',
      '无厂家公开的惯性矩/米重数据，本预设不携带 reference。',
    ],
  },
];

export function findProfilePreset(id: string): ProfilePreset | undefined {
  return PROFILE_PRESETS.find((preset) => preset.id === id);
}

export function presetIds(): readonly string[] {
  return PROFILE_PRESETS.map((preset) => preset.id);
}
