/** (seed, a, b, c) → [0,1) 결정적 해시. 입자마다 같은 값이 나오므로 어느 시간에서든 같은 모양이 재현된다. */
export function hash(seed: number, a: number, b: number, c: number): number {
  let h = (seed | 0) ^ Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ Math.imul(c | 0, 0xc2b2ae3d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
