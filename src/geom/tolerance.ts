// 几何容差集中定义（AGENTS.md 十一.4）：禁止在业务代码里散落魔法数。
// 每个常数必须写清适用量纲与为什么是这个量级。

export const TOL = {
  /** 两点重合判定，量纲 mm。1e-9 mm = 1 nm，远小于任何机械加工公差，不会误判有效短边。 */
  coincide: 1e-9,
  /**
   * 方向判定容差，无量纲。叉积 |ab×ac| <= orientRel·|ab|·|ac| 视为共线。
   * 双精度叉积的相对误差量级约 2.2e-16，取 1e-12 留 4 个量级余量：
   * 既能吸收大坐标下的舍入噪声，又不会把真实的小角度（<0.00006°）判成共线。
   */
  orientRel: 1e-12,
  /** 退化轮廓面积下限，量纲 mm^2。低于此值无法定义形心，直接拒绝输入。 */
  minArea: 1e-12,
  /** 手算对照验收口径，相对误差。积分法对多边形是精确解，只剩浮点舍入。 */
  relVerify: 1e-9,
  /** 主轴角归零判定，量纲 mm^4：|Ixy| 小于面积×特征尺寸²×此比例时视为已主轴对齐。 */
  principalZero: 1e-9,
  /** 输出 JSON 的有效数字位数，避免浮点噪声被误读成精度。 */
  outputSignificant: 12,
} as const;

export const assertFinite = (v: number, what: string): void => {
  if (!Number.isFinite(v)) throw new RangeError(`非有限数值：${what}=${v}`);
};
