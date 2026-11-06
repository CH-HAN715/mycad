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
    id: 'eu3030',
    title: '欧标 3030（槽宽 8 系列）',
    spec: {
      width: 30,
      height: 30,
      slot: { opening: 8.2, depth: 8, headWidth: 12, headStart: 2.5 },
      bore: { radius: 3.4 },
    },
    reference: {
      massPerMeterKg: 0.9,
      ixMm4: 28000,
      iyMm4: 28000,
      zxMm3: 1800,
      zyMm3: 1800,
      material: '6063-T5',
      elasticModulusMPa: 70000,
      sourceTitle: 'Bosch Rexroth 3842990720 标准型（A 3.1cm² / Ix 2.8cm⁴ / W 1.8cm³）',
      sourceUrl: 'https://www.boschrexroth.com/en/nz/p/strut-profile-3842990720/',
      checkedAt: '2026-11-06',
    },
    unverifiedFields: [
      'slot.depth / headWidth / headStart（槽腔细部无公开文字来源，按工程惯例理想化，需实测）',
      '槽口宽：公开来源在 8 与 8.2 之间不一致，取 8.2',
      '壁厚：公开来源 2 / 2.2 / 2.3 / 3 并存，未采信',
    ],
    notes: [
      '外形 30×30 与中心孔 φ6.8 有公开来源；惯性矩与米重取 Rexroth 标准型。',
      '30 系列公开来源同时存在轻型/标准/加重（Ix 2.6–3.5 cm⁴），本预设按标准型，采购前按实物核对。',
      '理想化截面算得 Ix=44928mm⁴，较公布值 28000mm⁴ 偏大 60.5%（内腔未建模）；校核走 profile 入口时自动取计算值与公布值的较小者。',
    ],
  },
  {
    id: 'eu4545',
    title: '欧标 4545（槽宽 10 系列）',
    spec: {
      width: 45,
      height: 45,
      slot: { opening: 10.2, depth: 12, headWidth: 16, headStart: 3 },
      bore: { radius: 6.25 },
    },
    reference: {
      massPerMeterKg: 1.87,
      ixMm4: 151200,
      iyMm4: 151200,
      zxMm3: 6520,
      zyMm3: 6520,
      material: '6063-T5',
      elasticModulusMPa: 70000,
      sourceTitle: 'Systéal / 米思米 45 系列标准型（A 662mm² / Ix 15.12cm⁴ / W 6.52cm³）',
      sourceUrl: 'https://www.systeal.com/en/45-series-profiles/127-rounded-aluminium-profile-10-mm-slot-45x45.html',
      checkedAt: '2026-11-06',
    },
    unverifiedFields: [
      'slot.depth / headWidth / headStart（槽腔细部无公开文字来源，按工程惯例理想化，需实测）',
      '槽口宽：10 与 10.2 并存，取 10.2',
      '国标 4545 为梅花中心孔、槽口近矩形，与本欧标预设不通用',
    ],
    notes: [
      '中心孔 φ12.5 取自 Systéal/LeanProducts 公开页；壁厚 2.0 取米思米标准型。',
      '同为「标准型」的惯性矩在不同厂家间对应 1.87 与 2.15 kg/m，说明筋位不同，不可混抄。',
      '理想化截面算得 Ix=240072mm⁴，较公布值 151200mm⁴ 偏大 58.8%（内腔未建模）；校核走 profile 入口时自动取计算值与公布值的较小者。',
    ],
  },
  {
    id: 'eu6060',
    title: '欧标 6060（槽宽 10 系列，轻型）',
    spec: {
      width: 60,
      height: 60,
      slot: { opening: 10.2, depth: 14, headWidth: 18, headStart: 3.5 },
      bore: { radius: 5.1 },
    },
    reference: {
      massPerMeterKg: 2.3,
      ixMm4: 292000,
      iyMm4: 292000,
      zxMm3: 9730,
      zyMm3: 9730,
      material: '6063-T5',
      elasticModulusMPa: 70000,
      sourceTitle: '米思米 LCF10-6060 轻型（A 8.42cm² / Ix 29.2cm⁴ / Zx 9.73cm³ / 2.30kg·m⁻¹）',
      sourceUrl: 'https://www.misumi.com.cn/pdf/vona/P13_202005_04.pdf',
      checkedAt: '2026-11-06',
    },
    unverifiedFields: [
      'slot.depth / headWidth / headStart（槽腔细部无公开文字来源，按工程惯例理想化，需实测）',
      '图纸标注 12.3 的几何含义未注明，未采信',
      '中心孔 φ10.2 是通孔还是 M12 底孔未证实',
    ],
    notes: [
      '60 系列分轻型/标准/重型，本预设取轻型（三家来源交叉最紧），标准型 Ix 45.02–58.79 cm⁴ 差异源于筋位不同。',
      '槽 10 用 M12 圆柱头螺栓，槽 8 用 M8，配件不通用。',
      '理想化截面算得 Ix=837428mm⁴，较公布值 292000mm⁴ 偏大 186.8%——尺寸越大内腔误差越严重，本系列的计算截面不可用于校核，必须走公布值；校核入口已自动取较小者。',
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
