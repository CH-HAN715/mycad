/**
 * L3 连接层 v1：槽宽→紧固件系列→连接件的默认规则表。
 *
 * 数值来源标注（AGENTS.md 十一.2）：默认值全部是「行业公开的工程惯例」，
 * 参考欧标型材公开资料（docs/调研-MayCAD对标与选型.md 来源清单），**非规范条文**。
 * 用户必须能整表替换；输出中每一处默认值都会带上 source 字段。
 * 本表不含任何厂商零件号。
 */

import { schemaVersionProblem } from '../geom/schema.ts';

export interface FastenerSeriesRule {
  /** 槽口宽下限（含），mm。 */
  readonly openingMinMm: number;
  /** 槽口宽上限（含），mm。 */
  readonly openingMaxMm: number;
  /** 推荐螺栓/螺母螺纹规格，如 'M6'。 */
  readonly boltSeries: string;
  /** 为什么是这个量级（一句话，进 provenance）。 */
  readonly rationale: string;
}

export interface ConnectRules {
  /** 槽宽 → 紧固件系列，按顺序取第一条命中的区间。 */
  readonly fastenerSeries: readonly FastenerSeriesRule[];
  /** 角件每侧螺栓孔的间距，mm（沿杆件方向）。 */
  readonly bracketHolePitchMm: number;
  /** 角件螺栓孔到杆件端面的最小距离，mm。 */
  readonly bracketHoleOffsetFromEndMm: number;
  /** 螺栓孔到截面角部的边距，mm，用于统计一面能放几个孔。 */
  readonly bracketEdgeMarginMm: number;
  /** 内置连接件（插入棒）单侧最小旋合深度，mm。 */
  readonly pegMinEngagementMm: number;
  /** 角件立边厚度（用于螺栓长度建议），mm。 */
  readonly bracketLegThicknessMm: number;
  /** 螺母+垫圈余量（用于螺栓长度建议），mm。 */
  readonly nutWasherAllowanceMm: number;
  /** 通光孔钻孔直径（按螺栓系列），mm；来源见 drillTableSource。 */
  readonly clearanceDrillBySeries: Readonly<Record<string, number>>;
  /** 攻丝底孔直径（按螺栓系列），mm；仅当工艺选择攻丝时使用。 */
  readonly tapDrillBySeries: Readonly<Record<string, number>>;
  /** 钻孔直径表的来源标注，必须出现在输出里。 */
  readonly drillTableSource: string;
  /** 图纸上的一般公差注记（ASCII，进 DXF）；量级类比公开资料，不是符合性声明。 */
  readonly generalToleranceNote: string;
  /** 整套默认值的来源标签，必须出现在输出里。 */
  readonly source: string;
}

/** 欧标公开资料里常见的槽宽/螺纹搭配；区间故意不重叠，命中规则可预期。 */
export const DEFAULT_FASTENER_SERIES: readonly FastenerSeriesRule[] = [
  { openingMinMm: 4.5, openingMaxMm: 6.5, boltSeries: 'M5', rationale: '工程惯例：6mm 槽配 M5 系列弹条螺母' },
  { openingMinMm: 6.5, openingMaxMm: 9, boltSeries: 'M6', rationale: '工程惯例：8mm 槽配 M6 系列' },
  { openingMinMm: 9, openingMaxMm: 11.5, boltSeries: 'M8', rationale: '工程惯例：10mm 槽配 M8 系列' },
  { openingMinMm: 11.5, openingMaxMm: 15, boltSeries: 'M10', rationale: '工程惯例：12~14mm 槽配 M10 系列' },
] as const;

export const DEFAULT_CONNECT_RULES: ConnectRules = {
  fastenerSeries: DEFAULT_FASTENER_SERIES,
  bracketHolePitchMm: 20,
  bracketHoleOffsetFromEndMm: 15,
  bracketEdgeMarginMm: 5,
  pegMinEngagementMm: 20,
  bracketLegThicknessMm: 4,
  nutWasherAllowanceMm: 5,
  // ISO 273 中系列通光孔与公制粗牙攻丝底孔的公开数值表（核对于 2026-11-06，来源见 drillTableSource）。
  clearanceDrillBySeries: { M5: 5.5, M6: 6.6, M8: 9, M10: 11 },
  tapDrillBySeries: { M5: 4.2, M6: 5, M8: 6.8, M10: 8.5 },
  drillTableSource:
    'ISO 273 medium series clearance holes / metric coarse tap drills, public tables, checked 2026-11-06; standard text not purchased, not a conformity claim',
  generalToleranceNote:
    'GENERAL TOL +/-0.3 mm (ENGINEERING PRACTICE, MAGNITUDE ANALOGOUS TO PUBLIC ISO 2768-m TABLE; NOT A CONFORMITY CLAIM)',
  source: '工程惯例（欧标型材公开资料归纳），非规范条文；可整表覆盖',
} as const;

export type SeriesMatch =
  | { readonly matched: true; readonly rule: FastenerSeriesRule }
  | { readonly matched: false; readonly reason: string };

/** 按槽口宽查紧固件系列；越界必须给出可执行的提示，不许静默取最近档。 */
export function matchFastenerSeries(rules: ConnectRules, openingMm: number): SeriesMatch {
  for (const rule of rules.fastenerSeries) {
    if (openingMm >= rule.openingMinMm && openingMm <= rule.openingMaxMm) {
      return { matched: true, rule };
    }
  }
  const covered = rules.fastenerSeries.map((r) => `${r.openingMinMm}~${r.openingMaxMm}`).join('、');
  return {
    matched: false,
    reason: `槽口宽 ${openingMm} mm 不在任何规则区间内（已覆盖：${covered} mm），请扩展 fastenerSeries 规则`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readNumberField(record: Record<string, unknown>, key: string, where: string, allowed: readonly string[]): number {
  if (!allowed.includes(key)) {
    throw new Error(`${where} 含未知字段：${key}；允许：${allowed.join('、')}`);
  }
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
    throw new Error(`${where}.${key} 必须是正的有限数，收到 ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * 解析用户提交的规则覆盖（浅合并：给了哪个字段就覆盖哪个字段）。
 * 未知字段直接拒绝——拼错的规则键不能被静默忽略。
 */
export function parseRulesOverride(raw: unknown): ConnectRules {
  if (!isRecord(raw)) throw new Error('rules 必须是 JSON 对象');
  const versionProblem = schemaVersionProblem(raw['schemaVersion']);
  if (versionProblem !== null) throw new Error(`rules ${versionProblem}`);
  const out: Record<string, unknown> = { ...DEFAULT_CONNECT_RULES };

  const numericKeys = [
    'bracketHolePitchMm',
    'bracketHoleOffsetFromEndMm',
    'bracketEdgeMarginMm',
    'pegMinEngagementMm',
    'bracketLegThicknessMm',
    'nutWasherAllowanceMm',
  ] as const;
  for (const key of numericKeys) {
    if (raw[key] !== undefined) out[key] = readNumberField(raw, key, 'rules', [...numericKeys, 'fastenerSeries', 'source']);
  }

  if (raw['fastenerSeries'] !== undefined) {
    const list = raw['fastenerSeries'];
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('rules.fastenerSeries 必须是非空数组');
    }
    out['fastenerSeries'] = list.map((item, i): FastenerSeriesRule => {
      const where = `rules.fastenerSeries[${i}]`;
      if (!isRecord(item)) throw new Error(`${where} 必须是对象`);
      for (const key of Object.keys(item)) {
        if (!['openingMinMm', 'openingMaxMm', 'boltSeries', 'rationale'].includes(key)) {
          throw new Error(`${where} 含未知字段：${key}`);
        }
      }
      const min = readNumberField(item, 'openingMinMm', where, ['openingMinMm', 'openingMaxMm', 'boltSeries', 'rationale']);
      const max = readNumberField(item, 'openingMaxMm', where, ['openingMinMm', 'openingMaxMm', 'boltSeries', 'rationale']);
      const bolt = item['boltSeries'];
      if (typeof bolt !== 'string' || bolt.trim().length === 0) {
        throw new Error(`${where}.boltSeries 必须是非空字符串，如 'M6'`);
      }
      if (!(max >= min)) throw new Error(`${where} 要求 openingMaxMm >= openingMinMm`);
      const rationale = item['rationale'] === undefined ? '用户自定义规则，来源未标注' : String(item['rationale']);
      return { openingMinMm: min, openingMaxMm: max, boltSeries: bolt, rationale };
    });
  }

  if (raw['source'] !== undefined) {
    if (typeof raw['source'] !== 'string' || raw['source'].trim().length === 0) {
      throw new Error('rules.source 必须是非空字符串（默认参数不得静默生效）');
    }
    out['source'] = raw['source'];
  }

  const stringKeys = ['source', 'drillTableSource', 'generalToleranceNote'] as const;
  for (const key of stringKeys) {
    if (raw[key] !== undefined) {
      const value = raw[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`rules.${key} 必须是非空字符串（默认参数与注记不得静默生效）`);
      }
      out[key] = value;
    }
  }

  const drillTables = ['clearanceDrillBySeries', 'tapDrillBySeries'] as const;
  for (const key of drillTables) {
    if (raw[key] === undefined) continue;
    const table = raw[key];
    if (!isRecord(table) || Object.keys(table).length === 0) {
      throw new Error(`rules.${key} 必须是非空对象，形如 {"M5":5.5}`);
    }
    const parsed: Record<string, number> = {};
    for (const [series, value] of Object.entries(table)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) {
        throw new Error(`rules.${key}.${series} 必须是正的有限数，收到 ${JSON.stringify(value)}`);
      }
      parsed[series] = value;
    }
    out[key] = parsed;
  }

  for (const key of Object.keys(raw)) {
    if (key === 'schemaVersion') continue;
    if (![...numericKeys, ...stringKeys, ...drillTables, 'fastenerSeries'].includes(key)) {
      throw new Error(
        `rules 含未知字段：${key}；允许：${['schemaVersion', ...numericKeys, ...stringKeys, ...drillTables, 'fastenerSeries'].join('、')}`,
      );
    }
  }

  return out as unknown as ConnectRules;
}
