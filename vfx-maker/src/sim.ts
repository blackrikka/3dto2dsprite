import { Effect, Emitter, Stop } from './types';
import { hash } from './rng';
import { hexToRgb } from './palette';

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  r: number;
  g: number;
  b: number;
  alpha: number;
  u: number;
  age: number;
}

const MAX_PER_EMITTER = 4000;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const DEG = Math.PI / 180;

interface RGBStop {
  t: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

function toRgbStops(stops: Stop[]): RGBStop[] {
  return stops.map((s) => {
    const c = hexToRgb(s.color) ?? [255, 255, 255];
    return { t: s.t, r: c[0], g: c[1], b: c[2], a: s.a };
  });
}

function sampleGradient(g: RGBStop[], u: number, out: { r: number; g: number; b: number; a: number }): void {
  if (u <= g[0].t) return void Object.assign(out, g[0]);
  const last = g[g.length - 1];
  if (u >= last.t) return void Object.assign(out, last);
  for (let i = 1; i < g.length; i++) {
    if (u <= g[i].t) {
      const a = g[i - 1], b = g[i];
      const k = b.t === a.t ? 0 : (u - a.t) / (b.t - a.t);
      out.r = lerp(a.r, b.r, k);
      out.g = lerp(a.g, b.g, k);
      out.b = lerp(a.b, b.b, k);
      out.a = lerp(a.a, b.a, k);
      return;
    }
  }
}

/** 이미터의 실제 입자 수 */
export function particleCount(e: Emitter, duration: number): number {
  if (e.mode === 'burst') return Math.min(MAX_PER_EMITTER, Math.max(0, Math.round(e.count)));
  const win = e.window > 0 ? e.window : Math.max(0.01, duration - e.start);
  return Math.min(MAX_PER_EMITTER, Math.max(0, Math.round(e.count * win)));
}

/**
 * 시간 T 에서 살아 있는 입자를 순서대로 콜백한다.
 * 상태를 저장하지 않고 입자 인덱스의 해시와 닫힌 형태의 운동 방정식으로 위치를 계산하므로
 * 임의 시간 접근이 정확하고, loop 가 켜져 있으면 duration 마다 끊김 없이 반복된다.
 */
export function forEachParticle(
  fx: Effect,
  ei: number,
  e: Emitter,
  T: number,
  cb: (p: Particle) => void,
): void {
  const D = fx.duration;
  const N = particleCount(e, D);
  if (N === 0) return;
  const win = e.window > 0 ? e.window : e.mode === 'burst' ? 0 : Math.max(0.01, D - e.start);
  const stops = toRgbStops(e.gradient);
  const col = { r: 255, g: 255, b: 255, a: 1 };
  const p: Particle = { x: 0, y: 0, vx: 0, vy: 0, size: 1, r: 255, g: 255, b: 255, alpha: 1, u: 0, age: 0 };
  const rot = e.shapeRot * DEG;
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const k = e.drag;
  const seed = fx.seed;

  for (let i = 0; i < N; i++) {
    const h = (c: number) => hash(seed, ei, i, c);
    // 발생 시각
    let ts: number;
    if (e.mode === 'burst') ts = e.start + (e.sweep ? (i + 0.5) / N : h(0)) * win;
    else ts = e.start + ((i + h(0) * 0.98) / N) * win;
    let age = T - ts;
    if (fx.loop) age = ((age % D) + D) % D;
    else if (age < 0) continue;
    let life = lerp(e.lifeMin, Math.max(e.lifeMin, e.lifeMax), h(5));
    if (fx.loop) life = Math.min(life, D);
    if (life <= 0 || age >= life) continue;
    const u = age / life;

    // 발생 위치 (모양 기준 오프셋)
    const s1 = e.sweep ? (i + 0.5) / N : h(1);
    const s2 = h(2);
    let ox = 0, oy = 0;
    switch (e.shape) {
      case 'circle': {
        const r = e.shapeW * Math.sqrt(s2);
        const a = 2 * Math.PI * s1;
        ox = Math.cos(a) * r; oy = Math.sin(a) * r;
        break;
      }
      case 'ring': {
        const a = 2 * Math.PI * s1;
        ox = Math.cos(a) * e.shapeW; oy = Math.sin(a) * e.shapeW;
        break;
      }
      case 'arc': {
        const a = (e.shapeRot + (s1 - 0.5) * e.shapeH) * DEG;
        ox = Math.cos(a) * e.shapeW; oy = Math.sin(a) * e.shapeW;
        break;
      }
      case 'line': {
        const lx = (s1 - 0.5) * e.shapeW;
        ox = lx * cr; oy = lx * sr;
        break;
      }
      case 'rect': {
        const lx = (s1 - 0.5) * e.shapeW, ly = (s2 - 0.5) * e.shapeH;
        ox = lx * cr - ly * sr; oy = lx * sr + ly * cr;
        break;
      }
      default:
        break;
    }

    // 초기 속도
    let dir: number;
    const out = Math.atan2(oy, ox);
    const jitter = (h(3) - 0.5) * e.spread * DEG;
    const hasOffset = ox !== 0 || oy !== 0;
    switch (e.dirMode) {
      case 'outward': dir = (hasOffset ? out : h(6) * Math.PI * 2) + jitter; break;
      case 'inward': dir = (hasOffset ? out : h(6) * Math.PI * 2) + Math.PI + jitter; break;
      case 'tangent': dir = (hasOffset ? out : h(6) * Math.PI * 2) + Math.PI / 2 + jitter; break;
      default: dir = e.angle * DEG + jitter;
    }
    const speed = lerp(e.speedMin, e.speedMax, h(4));
    const v0x = Math.cos(dir) * speed, v0y = Math.sin(dir) * speed;

    // 닫힌 형태의 위치/속도 (중력 g, 저항 k)
    let dx: number, dy: number, vx: number, vy: number;
    if (k < 1e-4) {
      dx = v0x * age + 0.5 * e.gravityX * age * age;
      dy = v0y * age + 0.5 * e.gravityY * age * age;
      vx = v0x + e.gravityX * age;
      vy = v0y + e.gravityY * age;
    } else {
      const ex = Math.exp(-k * age), f = (1 - ex) / k;
      const tx = e.gravityX / k, ty = e.gravityY / k;
      dx = tx * age + (v0x - tx) * f;
      dy = ty * age + (v0y - ty) * f;
      vx = tx + (v0x - tx) * ex;
      vy = ty + (v0y - ty) * ex;
    }
    // 흔들림: 초기 진행 방향에 수직으로
    if (e.wobble !== 0) {
      const w = e.wobble * Math.sin(2 * Math.PI * e.wobbleFreq * age + h(7) * 6.2832);
      dx += -Math.sin(dir) * w;
      dy += Math.cos(dir) * w;
    }

    sampleGradient(stops, u, col);
    let alpha = col.a;
    if (e.fadeIn > 0) alpha *= Math.min(1, u / e.fadeIn);
    if (e.fadeOut > 0) alpha *= Math.min(1, (1 - u) / e.fadeOut);
    if (alpha <= 0.003) continue;

    p.x = e.x + ox + dx;
    p.y = e.y + oy + dy;
    p.vx = vx;
    p.vy = vy;
    p.size = lerp(e.sizeStart, e.sizeEnd, u) * (1 + (h(8) - 0.5) * 2 * e.sizeRand);
    p.r = col.r; p.g = col.g; p.b = col.b;
    p.alpha = Math.min(1, alpha);
    p.u = u;
    p.age = age;
    cb(p);
  }
}
