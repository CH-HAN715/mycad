import type { Mm } from './units.ts';
import { U } from './units.ts';

/** 三维点，坐标单位固定 mm。 */
export interface Vec3 {
  readonly x: Mm;
  readonly y: Mm;
  readonly z: Mm;
}

export const v3 = (x: number, y: number, z: number): Vec3 => ({ x: U.mm(x), y: U.mm(y), z: U.mm(z) });

/** 两点距离，mm。 */
export function distance3(a: Vec3, b: Vec3): Mm {
  return U.mm(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z));
}

/** 逐坐标重合判定，容差量纲 mm。 */
export function samePoint3(a: Vec3, b: Vec3, tolerance: number): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance && Math.abs(a.z - b.z) <= tolerance;
}
