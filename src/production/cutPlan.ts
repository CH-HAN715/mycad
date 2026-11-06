import { TOL } from '../geom/tolerance.ts';
import { unknownKeyProblem } from '../geom/schema.ts';

/**
 * L5 生产层：一维定尺下料。
 *
 * 采用保守锯缝模型：每切下一段计一次锯缝，即一段占用 length + kerf。
 * 真实车间可能把棒料端面直接作为成品端面而少切一刀，本模型不会利用这一点，
 * 因此给出的用料量偏保守（不会偏乐观）。
 *
 * 求解器是 Best-Fit-Decreasing / First-Fit-Decreasing 启发式，不是最优解。
 * 报告同时给出箱数下界与差距，避免把启发式结果当成最优。
 */

export interface CutPieceInput {
  readonly id: string;
  readonly lengthMm: number;
  readonly quantity: number;
}

export interface CutOptions {
  readonly stockLengthMm: number;
  /** 锯缝宽度，mm。默认 0，但真实切割必须显式给出。 */
  readonly kerfMm?: number;
  /** 展开后的最大段数，默认 5000，防止误传巨大 quantity 卡死。 */
  readonly maxPieces?: number;
}

export interface PlacedPiece {
  readonly id: string;
  readonly instance: string;
  readonly lengthMm: number;
}

export interface StockBar {
  readonly index: number;
  readonly pieces: readonly PlacedPiece[];
  /** 成品长度合计，mm。 */
  readonly pieceLengthMm: number;
  /** 本棒锯缝损耗合计，mm。 */
  readonly kerfLossMm: number;
  /** 占用长度 = 成品合计 + 锯缝合计，mm。 */
  readonly usedMm: number;
  /** 余料 = 棒料长度 − 占用长度，mm。 */
  readonly leftoverMm: number;
  /** 总损耗 = 余料 + 锯缝，mm。 */
  readonly wasteMm: number;
}

export interface CutPlan {
  readonly stockLengthMm: number;
  readonly kerfMm: number;
  readonly solver: 'best_fit_decreasing';
  readonly bars: readonly StockBar[];
  readonly totalPieces: number;
  readonly totalPieceLengthMm: number;
  readonly totalKerfLossMm: number;
  readonly totalLeftoverMm: number;
  readonly totalWasteMm: number;
  readonly utilization: number;
  readonly lowerBoundBars: number;
  /** 是否达到箱数下界。达到只是「可能最优」，不等于已证明最优。 */
  readonly matchesLowerBound: boolean;
  readonly gapBars: number;
  readonly assumptions: readonly string[];
  readonly disclaimer: string;
}

export type CutErrorReason =
  | 'invalid_input'
  | 'duplicate_id'
  | 'piece_too_long'
  | 'too_many_pieces';

export class CutInputError extends Error {
  readonly code = 'E_INPUT_CUT';
  readonly hint: string;
  readonly reason: CutErrorReason;

  constructor(message: string, hint: string, reason: CutErrorReason) {
    super(message);
    this.name = 'CutInputError';
    this.hint = hint;
    this.reason = reason;
  }
}

function fail(message: string, hint: string, reason: CutErrorReason): never {
  throw new CutInputError(message, hint, reason);
}

const MAX_PIECES_DEFAULT = 5000;

export const CUT_PROVENANCE = {
  solver: 'best_fit_decreasing',
  assumptions: [
    '一维定尺下料：每根棒料长度相同，段与段之间只考虑锯缝',
    '保守锯缝：每段计一次锯缝，不假设棒料端面可免切',
    '所有段必须满足 length + kerf <= stockLength',
  ],
  limitations: [
    '启发式求解，不保证棒料数最少；报告给出下界与实际差距',
    '不考虑料头缺陷、端面修整、余料入库与二次利用',
    '不处理二维排版或型材弯曲',
  ],
  disclaimer:
    '下料方案为启发式结果，不是最优证明。实际采购与切割前必须由工艺人员复核锯缝、料头与余料。',
} as const;

function expandPieces(
  pieces: readonly CutPieceInput[],
  stockLength: number,
  kerf: number,
  maxPieces: number,
): PlacedPiece[] {
  const ids = new Set<string>();
  const expanded: PlacedPiece[] = [];
  for (const piece of pieces) {
    const pieceProblem = unknownKeyProblem(piece as unknown as Record<string, unknown>, [
      'id',
      'lengthMm',
      'quantity',
    ]);
    if (pieceProblem !== null) {
      fail(`段定义 ${pieceProblem}`, '允许的字段：id、lengthMm、quantity', 'invalid_input');
    }
    if (typeof piece.id !== 'string' || piece.id.trim().length === 0) {
      fail('段 id 必须是非空字符串', 'id 用于在方案中定位每一段', 'invalid_input');
    }
    if (ids.has(piece.id)) {
      fail(`段 id 重复：${piece.id}`, '每个段 id 只能出现一次，用 quantity 表示数量', 'duplicate_id');
    }
    ids.add(piece.id);
    if (!Number.isFinite(piece.lengthMm) || !(piece.lengthMm > 0)) {
      fail(`段 ${piece.id} 的长度必须是正有限数`, '长度单位为 mm', 'invalid_input');
    }
    if (!Number.isInteger(piece.quantity) || piece.quantity < 1) {
      fail(`段 ${piece.id} 的数量必须是正整数`, '数量用整数表示', 'invalid_input');
    }
    if (piece.lengthMm + kerf > stockLength + TOL.coincide) {
      fail(
        `段 ${piece.id} 长度 ${piece.lengthMm} mm + 锯缝 ${kerf} mm 超过棒料 ${stockLength} mm`,
        '换更长棒料，或把该段拆成多段',
        'piece_too_long',
      );
    }
    for (let i = 0; i < piece.quantity; i++) {
      expanded.push({ id: piece.id, instance: `${piece.id}#${i + 1}`, lengthMm: piece.lengthMm });
    }
    if (expanded.length > maxPieces) {
      fail(
        `展开后段数超过上限 ${maxPieces}`,
        `减少 quantity，或显式提高 maxPieces（当前 ${maxPieces}）`,
        'too_many_pieces',
      );
    }
  }
  return expanded;
}

interface Bin {
  readonly pieces: PlacedPiece[];
  pieceLength: number;
  used: number;
}

function pack(expanded: readonly PlacedPiece[], stockLength: number, kerf: number, bestFit: boolean): Bin[] {
  const bins: Bin[] = [];
  for (const piece of expanded) {
    let target: Bin | null = null;
    let bestRemaining = Number.POSITIVE_INFINITY;
    for (const bin of bins) {
      const nextUsed = bin.used + piece.lengthMm + kerf;
      if (nextUsed > stockLength + TOL.coincide) continue;
      if (!bestFit) {
        target = bin;
        break;
      }
      const remaining = stockLength - nextUsed;
      if (remaining < bestRemaining) {
        bestRemaining = remaining;
        target = bin;
      }
    }
    if (target === null) {
      target = { pieces: [], pieceLength: 0, used: 0 };
      bins.push(target);
    }
    target.pieces.push(piece);
    target.pieceLength += piece.lengthMm;
    target.used += piece.lengthMm + kerf;
  }
  return bins;
}

function toBars(bins: readonly Bin[], stockLength: number, kerf: number): StockBar[] {
  return bins.map((bin, index) => {
    const kerfLoss = kerf * bin.pieces.length;
    const leftover = stockLength - bin.used;
    return {
      index: index + 1,
      pieces: bin.pieces,
      pieceLengthMm: bin.pieceLength,
      kerfLossMm: kerfLoss,
      usedMm: bin.used,
      leftoverMm: leftover < TOL.coincide ? 0 : leftover,
      wasteMm: bin.used - bin.pieceLength + Math.max(0, leftover),
    };
  });
}

export function planCuts(pieces: readonly CutPieceInput[], options: CutOptions): CutPlan {
  const stockLength = options.stockLengthMm;
  const kerf = options.kerfMm ?? 0;
  const maxPieces = options.maxPieces ?? MAX_PIECES_DEFAULT;

  if (!Number.isFinite(stockLength) || !(stockLength > 0)) {
    fail('stockLengthMm 必须是正有限数', '棒料长度单位为 mm', 'invalid_input');
  }
  if (!Number.isFinite(kerf) || kerf < 0) {
    fail('kerfMm 必须是非负有限数', '锯缝宽度单位为 mm；不确定时用保守值', 'invalid_input');
  }
  if (kerf >= stockLength) {
    fail('锯缝不小于棒料长度', '检查 kerfMm 与 stockLengthMm 的单位', 'invalid_input');
  }
  if (!Number.isInteger(maxPieces) || maxPieces < 1) {
    fail('maxPieces 必须是正整数', '用于防止展开后段数失控', 'invalid_input');
  }
  if (pieces.length === 0) {
    fail('没有可下料的段', 'pieces 至少包含一项，或不要调用下料', 'invalid_input');
  }

  const expanded = expandPieces(pieces, stockLength, kerf, maxPieces);
  // 稳定降序：长度相同按 id 排序，保证结果可复现。
  expanded.sort((a, b) => (b.lengthMm - a.lengthMm) || a.instance.localeCompare(b.instance));

  const bestFitBins = pack(expanded, stockLength, kerf, true);
  const firstFitBins = pack(expanded, stockLength, kerf, false);
  const bins = bestFitBins.length <= firstFitBins.length ? bestFitBins : firstFitBins;
  const bars = toBars(bins, stockLength, kerf);

  const totalPieceLength = bars.reduce((sum, bar) => sum + bar.pieceLengthMm, 0);
  const totalKerfLoss = bars.reduce((sum, bar) => sum + bar.kerfLossMm, 0);
  const totalLeftover = bars.reduce((sum, bar) => sum + bar.leftoverMm, 0);
  const demand = totalPieceLength + totalKerfLoss;
  const lowerBoundBars = Math.max(1, Math.ceil(demand / stockLength - TOL.coincide));
  const usedStock = bars.length * stockLength;

  return {
    stockLengthMm: stockLength,
    kerfMm: kerf,
    solver: CUT_PROVENANCE.solver,
    bars,
    totalPieces: expanded.length,
    totalPieceLengthMm: totalPieceLength,
    totalKerfLossMm: totalKerfLoss,
    totalLeftoverMm: totalLeftover,
    totalWasteMm: totalKerfLoss + totalLeftover,
    utilization: totalPieceLength / usedStock,
    lowerBoundBars,
    matchesLowerBound: bars.length === lowerBoundBars,
    gapBars: bars.length - lowerBoundBars,
    assumptions: CUT_PROVENANCE.assumptions,
    disclaimer: CUT_PROVENANCE.disclaimer,
  };
}
