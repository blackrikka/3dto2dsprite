import { Effect, Emitter } from './types';
import { Particle, forEachParticle } from './sim';

/** 곱해진 알파(premultiplied) 부동소수점 버퍼. 일반 합성(over)과 가산 합성을 지원한다. */
export class Raster {
  readonly P: Float32Array;
  readonly A: Float32Array;
  private mark: Int32Array;
  private gen = 0;

  constructor(readonly w: number, readonly h: number) {
    this.P = new Float32Array(w * h * 3);
    this.A = new Float32Array(w * h);
    this.mark = new Int32Array(w * h);
  }

  clear(): void {
    this.P.fill(0);
    this.A.fill(0);
    this.mark.fill(0);
    this.gen = 0;
  }

  /** 입자 하나를 그리기 시작 (같은 입자가 한 픽셀에 두 번 합성되는 것을 막는다) */
  begin(): void {
    this.gen++;
  }

  put(x: number, y: number, r: number, g: number, b: number, a: number, add: boolean): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    const i = y * this.w + x;
    if (this.mark[i] === this.gen) return;
    this.mark[i] = this.gen;
    const P = this.P, j = i * 3;
    if (add) {
      P[j] += r * a; P[j + 1] += g * a; P[j + 2] += b * a;
      this.A[i] = Math.min(1, this.A[i] + a);
    } else {
      const k = 1 - a;
      P[j] = r * a + P[j] * k; P[j + 1] = g * a + P[j + 1] * k; P[j + 2] = b * a + P[j + 2] * k;
      this.A[i] = a + this.A[i] * k;
    }
  }

  /** 곱해지지 않은(straight) RGBA 8비트로 변환 */
  toRGBA(): Uint8ClampedArray {
    const out = new Uint8ClampedArray(this.w * this.h * 4);
    for (let i = 0; i < this.A.length; i++) {
      const a = this.A[i];
      if (a <= 0.004) continue;
      const j = i * 3, o = i * 4;
      out[o] = this.P[j] / a;
      out[o + 1] = this.P[j + 1] / a;
      out[o + 2] = this.P[j + 2] / a;
      out[o + 3] = a * 255;
    }
    return out;
  }
}

/** 입자 모양 마스크 → 0(그리지 않음)~1(불투명도 배율) */
function cover(kind: Emitter['pshape'], dx: number, dy: number, rad: number): number {
  switch (kind) {
    case 'circle': return dx * dx + dy * dy <= rad * rad ? 1 : 0;
    case 'glow': {
      const t = 1 - Math.hypot(dx, dy) / rad;
      return t > 0 ? t * t * (3 - 2 * t) : 0;
    }
    case 'diamond': return Math.abs(dx) + Math.abs(dy) <= rad ? 1 : 0;
    case 'plus': {
      const th = Math.max(0.5, rad / 3.2);
      return (Math.abs(dx) <= th && Math.abs(dy) <= rad) || (Math.abs(dy) <= th && Math.abs(dx) <= rad) ? 1 : 0;
    }
    case 'star': return Math.sqrt(Math.abs(dx)) + Math.sqrt(Math.abs(dy)) <= Math.sqrt(rad) * 1.05 ? 1 : 0;
    case 'ring': {
      const d = Math.hypot(dx, dy);
      return d <= rad && d >= rad - Math.max(1.2, rad * 0.14) ? 1 : 0;
    }
    default: return 1;
  }
}

export function drawParticle(r: Raster, p: Particle, e: Emitter): void {
  const add = e.blend === 'add';
  const d = Math.max(1, Math.round(p.size));
  const cx = Math.round(p.x), cy = Math.round(p.y);
  r.begin();

  if (e.pshape === 'streak') {
    const sp = Math.hypot(p.vx, p.vy);
    if (sp < 1e-3) {
      stamp(r, cx, cy, d, p, add, 1);
      return;
    }
    const len = Math.max(d, sp * e.streak);
    const ux = p.vx / sp, uy = p.vy / sp;
    const steps = Math.max(1, Math.ceil(len));
    // 머리(현재 위치)부터 꼬리 쪽으로 그려 머리가 가장 밝게 남도록 한다
    for (let s = 0; s <= steps; s++) {
      const t = s / steps; // 0 = 머리
      const px = Math.round(p.x - ux * len * t), py = Math.round(p.y - uy * len * t);
      stamp(r, px, py, d, p, add, 1 - 0.75 * t);
    }
    return;
  }
  if (d === 1) {
    r.put(cx, cy, p.r, p.g, p.b, p.alpha, add);
    return;
  }
  stamp(r, cx, cy, d, p, add, 1, e.pshape);
}

function stamp(r: Raster, cx: number, cy: number, d: number, p: Particle, add: boolean, mul: number, kind: Emitter['pshape'] = 'square'): void {
  const x0 = cx - Math.floor(d / 2), y0 = cy - Math.floor(d / 2), rad = d / 2;
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < d; i++) {
      const c = kind === 'square' || kind === 'streak' ? 1 : cover(kind, i + 0.5 - rad, j + 0.5 - rad, rad);
      if (c > 0) r.put(x0 + i, y0 + j, p.r, p.g, p.b, p.alpha * c * mul, add);
    }
  }
}

/** 시간 T 의 이펙트를 straight RGBA 로 렌더 (후처리 전) */
export function renderRaw(fx: Effect, T: number, r: Raster): Uint8ClampedArray {
  r.clear();
  fx.emitters.forEach((e, ei) => {
    if (!e.enabled) return;
    forEachParticle(fx, ei, e, T, (p) => drawParticle(r, p, e));
  });
  return r.toRGBA();
}
