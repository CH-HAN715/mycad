// 单位在类型层固定（AGENTS.md 十一.4）：branded number，零运行时开销。
// 禁止裸数字跨层传递——跨层函数签名必须带单位类型。

export type Mm = number & { readonly __u: 'mm' };
export type Mm2 = number & { readonly __u: 'mm^2' };
export type Mm3 = number & { readonly __u: 'mm^3' };
export type Mm4 = number & { readonly __u: 'mm^4' };
export type Rad = number & { readonly __u: 'rad' };
export type Deg = number & { readonly __u: 'deg' };
export type Ratio = number & { readonly __u: 'ratio' };
export type N = number & { readonly __u: 'N' };
export type Nmm = number & { readonly __u: 'N*mm' };
export type MPa = number & { readonly __u: 'MPa' };
export type Kg = number & { readonly __u: 'kg' };
export type KgPerM = number & { readonly __u: 'kg/m' };

export const U = {
  mm: (v: number): Mm => v as Mm,
  mm2: (v: number): Mm2 => v as Mm2,
  mm3: (v: number): Mm3 => v as Mm3,
  mm4: (v: number): Mm4 => v as Mm4,
  rad: (v: number): Rad => v as Rad,
  deg: (v: number): Deg => v as Deg,
  ratio: (v: number): Ratio => v as Ratio,
  n: (v: number): N => v as N,
  nmm: (v: number): Nmm => v as Nmm,
  mpa: (v: number): MPa => v as MPa,
  kg: (v: number): Kg => v as Kg,
  kgPerM: (v: number): KgPerM => v as KgPerM,
} as const;

export const deg2rad = (d: Deg): Rad => ((d * Math.PI) / 180) as Rad;
export const rad2deg = (r: Rad): Deg => ((r * 180) / Math.PI) as Deg;

/** 输出层的单位声明，供 CLI/JSON 消费方校验语义（agent 不会把 mm^4 当成 mm^2）。 */
export const UNIT_SCHEMA = {
  length: 'mm',
  area: 'mm^2',
  firstMoment: 'mm^3',
  secondMoment: 'mm^4',
  sectionModulus: 'mm^3',
  angle: 'deg',
  force: 'N',
  moment: 'N*mm',
  stress: 'MPa',
  mass: 'kg',
  linearDensity: 'kg/m',
} as const;

export type UnitSchemaKey = keyof typeof UNIT_SCHEMA;
