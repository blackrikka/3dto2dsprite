export type PaletteMode = 'none' | 'auto' | 'pico8' | 'gameboy' | 'sweetie16' | 'custom';
export type Shape = 'point' | 'circle' | 'ring' | 'line' | 'rect' | 'arc';
export type DirMode = 'angle' | 'outward' | 'inward' | 'tangent';
export type PShape = 'square' | 'circle' | 'glow' | 'diamond' | 'plus' | 'star' | 'ring' | 'streak';
export type Blend = 'normal' | 'add';
export type AlphaMode = 'keep' | 'threshold' | 'dither';

export interface Stop {
  /** 수명 비율 0~1 */
  t: number;
  color: string;
  /** 불투명도 0~1 */
  a: number;
}

export interface Emitter {
  name: string;
  enabled: boolean;
  // 발생
  mode: 'burst' | 'continuous';
  /** burst: 입자 수 / continuous: 초당 입자 수 */
  count: number;
  start: number;
  /** burst: 발생 시간 폭(0=한 번에) / continuous: 발생 지속 시간(0=끝까지) */
  window: number;
  // 위치와 모양 (픽셀 좌표, 0,0 = 왼쪽 위)
  x: number;
  y: number;
  shape: Shape;
  shapeW: number;
  shapeH: number;
  shapeRot: number;
  /** true 면 발생 순서대로 모양을 따라 순차 배치 (슬래시/빔/링 확장에 사용) */
  sweep: boolean;
  // 움직임
  dirMode: DirMode;
  /** 0 = 오른쪽, 90 = 아래, -90 = 위 */
  angle: number;
  spread: number;
  speedMin: number;
  speedMax: number;
  gravityX: number;
  gravityY: number;
  drag: number;
  wobble: number;
  wobbleFreq: number;
  lifeMin: number;
  lifeMax: number;
  // 모양/색
  pshape: PShape;
  sizeStart: number;
  sizeEnd: number;
  sizeRand: number;
  /** streak: 속도 × 이 값(초)만큼 꼬리를 그린다 */
  streak: number;
  gradient: Stop[];
  blend: Blend;
  fadeIn: number;
  fadeOut: number;
}

export interface Post {
  alphaMode: AlphaMode;
  alphaThreshold: number;
  paletteMode: PaletteMode;
  colors: number;
  customPalette: string;
  outline: boolean;
  outlineColor: string;
}

export interface Effect {
  name: string;
  width: number;
  height: number;
  duration: number;
  fps: number;
  loop: boolean;
  seed: number;
  emitters: Emitter[];
  post: Post;
}

export const defaultEmitter = (): Emitter => ({
  name: '이미터',
  enabled: true,
  mode: 'continuous',
  count: 30,
  start: 0,
  window: 0,
  x: 64,
  y: 64,
  shape: 'point',
  shapeW: 10,
  shapeH: 10,
  shapeRot: 0,
  sweep: false,
  dirMode: 'angle',
  angle: -90,
  spread: 40,
  speedMin: 20,
  speedMax: 50,
  gravityX: 0,
  gravityY: 0,
  drag: 0,
  wobble: 0,
  wobbleFreq: 2,
  lifeMin: 0.5,
  lifeMax: 0.9,
  pshape: 'circle',
  sizeStart: 6,
  sizeEnd: 1,
  sizeRand: 0.2,
  streak: 0.06,
  gradient: [
    { t: 0, color: '#fff2a8', a: 1 },
    { t: 0.5, color: '#ff9a2e', a: 0.9 },
    { t: 1, color: '#c0301a', a: 0 },
  ],
  blend: 'add',
  fadeIn: 0,
  fadeOut: 0,
});

export const defaultPost = (): Post => ({
  alphaMode: 'dither',
  alphaThreshold: 128,
  paletteMode: 'auto',
  colors: 16,
  customPalette: '#1a1c2c #5d275d #b13e53 #ef7d57 #ffcd75 #f4f4f4',
  outline: false,
  outlineColor: '#1a1020',
});

export const defaultEffect = (): Effect => ({
  name: '새 이펙트',
  width: 128,
  height: 128,
  duration: 1,
  fps: 12,
  loop: true,
  seed: 1,
  emitters: [defaultEmitter()],
  post: defaultPost(),
});

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** 임의의 JSON 을 검증해 안전한 Effect 로 만든다 (파일 불러오기/저장된 설정 복원용) */
export function sanitizeEffect(raw: unknown): Effect {
  const base = defaultEffect();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const merge = <T extends object>(def: T, src: unknown): T => {
    const out = { ...def } as Record<string, unknown>;
    if (src && typeof src === 'object') {
      for (const k of Object.keys(def)) {
        const v = (src as Record<string, unknown>)[k];
        if (typeof v === typeof out[k] && !(typeof v === 'number' && !Number.isFinite(v))) out[k] = v;
      }
    }
    return out as T;
  };
  const e = merge(base, r);
  e.width = clamp(Math.round(e.width), 8, 512);
  e.height = clamp(Math.round(e.height), 8, 512);
  e.duration = clamp(e.duration, 0.1, 10);
  e.fps = clamp(Math.round(e.fps), 1, 60);
  e.seed = Math.round(e.seed);
  e.post = merge(defaultPost(), r.post);
  if (!['keep', 'threshold', 'dither'].includes(e.post.alphaMode)) e.post.alphaMode = 'dither';
  if (!['none', 'auto', 'pico8', 'gameboy', 'sweetie16', 'custom'].includes(e.post.paletteMode)) e.post.paletteMode = 'auto';
  e.post.colors = clamp(Math.round(e.post.colors), 2, 64);
  const list = Array.isArray(r.emitters) ? r.emitters : base.emitters;
  e.emitters = list.slice(0, 32).map((raw2) => {
    const em = merge(defaultEmitter(), raw2);
    const g = (raw2 as { gradient?: unknown })?.gradient;
    if (Array.isArray(g)) {
      const stops = g
        .map((s) => merge({ t: 0, color: '#ffffff', a: 1 } as Stop, s))
        .map((s) => ({ t: clamp(s.t, 0, 1), color: /^#[0-9a-fA-F]{6}$/.test(s.color) ? s.color : '#ffffff', a: clamp(s.a, 0, 1) }))
        .sort((a, b) => a.t - b.t)
        .slice(0, 8);
      if (stops.length >= 2) em.gradient = stops;
    }
    return em;
  });
  if (!e.emitters.length) e.emitters = [defaultEmitter()];
  return e;
}
