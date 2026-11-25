import { Effect, Emitter, Stop, defaultEmitter, defaultPost } from './types';

const em = (over: Partial<Emitter>): Emitter => ({ ...defaultEmitter(), ...over });
const st = (t: number, color: string, a = 1): Stop => ({ t, color, a });
const fx = (over: Partial<Effect> & Pick<Effect, 'name' | 'emitters'>): Effect => ({
  width: 128,
  height: 128,
  duration: 1,
  fps: 12,
  loop: true,
  seed: 1,
  post: defaultPost(),
  ...over,
});

export interface Preset {
  id: string;
  label: string;
  make: () => Effect;
}

export const PRESETS: Preset[] = [
  {
    id: 'campfire',
    label: '모닥불 (루프)',
    make: () =>
      fx({
        name: '모닥불',
        width: 96,
        height: 96,
        duration: 1,
        emitters: [
          em({ name: '연기', count: 9, x: 48, y: 50, shape: 'circle', shapeW: 4, angle: -90, spread: 24, speedMin: 10, speedMax: 18, gravityY: -8, drag: 0.4, wobble: 4, wobbleFreq: 1, lifeMin: 0.8, lifeMax: 1, pshape: 'circle', sizeStart: 6, sizeEnd: 15, sizeRand: 0.2, blend: 'normal', gradient: [st(0, '#5b6070', 0), st(0.25, '#5b6070', 0.4), st(1, '#2a2d38', 0)] }),
          em({ name: '불꽃', count: 95, x: 48, y: 86, shape: 'circle', shapeW: 9, angle: -90, spread: 20, speedMin: 24, speedMax: 52, gravityY: -34, drag: 0.5, wobble: 4, wobbleFreq: 3, lifeMin: 0.5, lifeMax: 1, pshape: 'circle', sizeStart: 14, sizeEnd: 1, sizeRand: 0.3, fadeIn: 0.06, gradient: [st(0, '#ffd86a', 0.9), st(0.35, '#ff9a2a', 0.9), st(0.7, '#e03a16', 0.75), st(1, '#6a1a12', 0)] }),
          em({ name: '불티', count: 14, x: 48, y: 76, shape: 'circle', shapeW: 5, angle: -90, spread: 50, speedMin: 25, speedMax: 55, gravityY: -10, drag: 0.3, wobble: 5, wobbleFreq: 4, lifeMin: 0.7, lifeMax: 1, pshape: 'square', sizeStart: 2, sizeEnd: 1, sizeRand: 0, gradient: [st(0, '#ffe08a'), st(1, '#ff6a1e', 0)] }),
        ],
      }),
  },
  {
    id: 'explosion',
    label: '폭발',
    make: () =>
      fx({
        name: '폭발',
        duration: 0.9,
        fps: 16,
        loop: false,
        emitters: [
          em({ name: '연기', mode: 'burst', count: 16, start: 0.06, window: 0.1, x: 64, y: 70, shape: 'circle', shapeW: 10, dirMode: 'outward', spread: 0, speedMin: 10, speedMax: 36, drag: 1.4, gravityY: -14, lifeMin: 0.55, lifeMax: 0.8, pshape: 'circle', sizeStart: 14, sizeEnd: 28, sizeRand: 0.3, blend: 'normal', gradient: [st(0, '#6a626e', 0.85), st(1, '#2c2a33', 0)] }),
          em({ name: '화염구', mode: 'burst', count: 38, window: 0.06, x: 64, y: 64, shape: 'circle', shapeW: 8, dirMode: 'outward', spread: 0, speedMin: 25, speedMax: 95, drag: 3.5, lifeMin: 0.3, lifeMax: 0.65, pshape: 'circle', sizeStart: 18, sizeEnd: 5, sizeRand: 0.4, blend: 'normal', gradient: [st(0, '#fff4b0'), st(0.3, '#ff9a2e'), st(0.65, '#c4341a', 0.95), st(1, '#3a1a16', 0)] }),
          em({ name: '불꽃', mode: 'burst', count: 28, x: 64, y: 64, dirMode: 'outward', speedMin: 90, speedMax: 210, drag: 2.2, gravityY: 70, lifeMin: 0.25, lifeMax: 0.55, pshape: 'streak', sizeStart: 2, sizeEnd: 1, sizeRand: 0, streak: 0.05, gradient: [st(0, '#fff2a0'), st(0.5, '#ffa030'), st(1, '#ff4a10', 0)] }),
          em({ name: '충격파', mode: 'burst', count: 1, x: 64, y: 64, speedMin: 0, speedMax: 0, lifeMin: 0.4, lifeMax: 0.4, pshape: 'ring', sizeStart: 10, sizeEnd: 118, sizeRand: 0, gradient: [st(0, '#ffffff', 0.9), st(1, '#ffd27a', 0)] }),
          em({ name: '섬광', mode: 'burst', count: 1, x: 64, y: 64, speedMin: 0, speedMax: 0, lifeMin: 0.16, lifeMax: 0.16, pshape: 'circle', sizeStart: 60, sizeEnd: 6, sizeRand: 0, gradient: [st(0, '#ffffff'), st(1, '#ffe27a', 0.6)] }),
        ],
      }),
  },
  {
    id: 'hit',
    label: '타격 스파크',
    make: () =>
      fx({
        name: '타격',
        post: { ...defaultPost(), alphaMode: 'threshold', alphaThreshold: 70 },
        width: 64,
        height: 64,
        duration: 0.4,
        fps: 20,
        loop: false,
        emitters: [
          em({ name: '스파크', mode: 'burst', count: 16, x: 32, y: 32, dirMode: 'outward', speedMin: 70, speedMax: 140, drag: 3.5, lifeMin: 0.12, lifeMax: 0.28, pshape: 'streak', sizeStart: 2, sizeEnd: 1, sizeRand: 0, streak: 0.06, gradient: [st(0, '#ffffff'), st(0.5, '#ffe14a'), st(1, '#ff7a1a', 0)] }),
          em({ name: '충격 링', mode: 'burst', count: 1, x: 32, y: 32, speedMin: 0, speedMax: 0, lifeMin: 0.2, lifeMax: 0.2, pshape: 'ring', sizeStart: 6, sizeEnd: 40, sizeRand: 0, gradient: [st(0, '#ffffff', 0.9), st(1, '#ffffff', 0)] }),
          em({ name: '중심 섬광', mode: 'burst', count: 1, x: 32, y: 32, speedMin: 0, speedMax: 0, lifeMin: 0.14, lifeMax: 0.14, pshape: 'star', sizeStart: 34, sizeEnd: 4, sizeRand: 0, gradient: [st(0, '#ffffff'), st(1, '#fff08a', 0.7)] }),
        ],
      }),
  },
  {
    id: 'slash',
    label: '슬래시 (베기)',
    make: () =>
      fx({
        name: '슬래시',
        post: { ...defaultPost(), alphaMode: 'threshold', alphaThreshold: 70 },
        width: 96,
        height: 96,
        duration: 0.32,
        fps: 20,
        loop: false,
        emitters: [
          em({ name: '궤적', mode: 'burst', count: 34, window: 0.1, sweep: true, x: 40, y: 58, shape: 'arc', shapeW: 36, shapeH: 130, shapeRot: -50, dirMode: 'tangent', spread: 0, speedMin: 0, speedMax: 0, lifeMin: 0.13, lifeMax: 0.17, pshape: 'diamond', sizeStart: 9, sizeEnd: 1, sizeRand: 0, gradient: [st(0, '#ffffff'), st(0.5, '#8cecff', 0.95), st(1, '#3a7bff', 0)] }),
          em({ name: '안쪽 궤적', mode: 'burst', count: 24, window: 0.1, sweep: true, x: 40, y: 58, shape: 'arc', shapeW: 28, shapeH: 110, shapeRot: -50, speedMin: 0, speedMax: 0, lifeMin: 0.1, lifeMax: 0.13, pshape: 'square', sizeStart: 4, sizeEnd: 1, sizeRand: 0, gradient: [st(0, '#ffffff'), st(1, '#b6f4ff', 0)] }),
          em({ name: '불꽃', mode: 'burst', count: 10, start: 0.06, window: 0.06, x: 40, y: 58, shape: 'arc', shapeW: 36, shapeH: 130, shapeRot: -50, dirMode: 'outward', speedMin: 30, speedMax: 70, drag: 3, lifeMin: 0.12, lifeMax: 0.22, pshape: 'streak', sizeStart: 2, sizeEnd: 1, sizeRand: 0, streak: 0.05, gradient: [st(0, '#ffffff'), st(1, '#7fe9ff', 0)] }),
        ],
      }),
  },
  {
    id: 'smoke',
    label: '연기 (루프)',
    make: () =>
      fx({
        name: '연기',
        width: 96,
        height: 96,
        duration: 1.5,
        emitters: [
          em({ name: '연기', count: 14, x: 48, y: 80, shape: 'circle', shapeW: 6, angle: -90, spread: 26, speedMin: 14, speedMax: 26, gravityY: -6, drag: 0.5, wobble: 6, wobbleFreq: 0.9, lifeMin: 1.2, lifeMax: 1.5, pshape: 'circle', sizeStart: 8, sizeEnd: 26, sizeRand: 0.25, blend: 'normal', gradient: [st(0, '#8a8896', 0), st(0.15, '#8a8896', 0.7), st(0.6, '#5a5866', 0.45), st(1, '#3a3844', 0)] }),
        ],
      }),
  },
  {
    id: 'charge',
    label: '마법 차징 (루프)',
    make: () =>
      fx({
        name: '차징',
        width: 96,
        height: 96,
        duration: 1.2,
        emitters: [
          em({ name: '중심 빛', mode: 'burst', count: 1, x: 48, y: 48, speedMin: 0, speedMax: 0, lifeMin: 1.2, lifeMax: 1.2, pshape: 'glow', sizeStart: 18, sizeEnd: 34, sizeRand: 0, fadeIn: 0.35, fadeOut: 0.35, gradient: [st(0, '#9ff1ff', 0.9), st(1, '#3b82ff', 0.9)] }),
          em({ name: '빨려드는 입자', count: 44, x: 48, y: 48, shape: 'ring', shapeW: 40, dirMode: 'inward', spread: 12, speedMin: 30, speedMax: 40, lifeMin: 0.95, lifeMax: 1.05, pshape: 'circle', sizeStart: 4, sizeEnd: 1, sizeRand: 0.2, fadeIn: 0.1, gradient: [st(0, '#d8fbff'), st(0.6, '#5ec8ff'), st(1, '#3b6bff', 0.3)] }),
          em({ name: '반짝임', count: 12, x: 48, y: 48, shape: 'circle', shapeW: 26, speedMin: 0, speedMax: 0, lifeMin: 0.5, lifeMax: 0.8, pshape: 'star', sizeStart: 7, sizeEnd: 0, sizeRand: 0.3, gradient: [st(0, '#ffffff'), st(1, '#9ff1ff')] }),
        ],
      }),
  },
  {
    id: 'heal',
    label: '힐링 (루프)',
    make: () =>
      fx({
        name: '힐링',
        width: 64,
        height: 96,
        duration: 1.5,
        emitters: [
          em({ name: '바닥 빛', mode: 'burst', count: 1, x: 32, y: 84, speedMin: 0, speedMax: 0, lifeMin: 1.5, lifeMax: 1.5, pshape: 'glow', sizeStart: 34, sizeEnd: 42, sizeRand: 0, fadeIn: 0.4, fadeOut: 0.4, gradient: [st(0, '#6bff9a', 0.45), st(1, '#6bff9a', 0.45)] }),
          em({ name: '십자 반짝임', count: 12, x: 32, y: 82, shape: 'circle', shapeW: 14, angle: -90, spread: 12, speedMin: 14, speedMax: 24, wobble: 4, wobbleFreq: 1.4, lifeMin: 1, lifeMax: 1.4, pshape: 'plus', sizeStart: 7, sizeEnd: 2, sizeRand: 0.3, fadeIn: 0.15, gradient: [st(0, '#e4ffd8'), st(0.5, '#6bff9a'), st(1, '#25b85a', 0)] }),
          em({ name: '작은 점', count: 14, x: 32, y: 84, shape: 'circle', shapeW: 18, angle: -90, spread: 20, speedMin: 18, speedMax: 34, wobble: 3, wobbleFreq: 2, lifeMin: 0.9, lifeMax: 1.4, pshape: 'square', sizeStart: 2, sizeEnd: 1, sizeRand: 0, gradient: [st(0, '#ffffff'), st(1, '#6bff9a', 0)] }),
        ],
      }),
  },
  {
    id: 'snow',
    label: '눈 (루프)',
    make: () =>
      fx({
        name: '눈',
        width: 96,
        height: 96,
        duration: 2,
        emitters: [
          em({ name: '눈송이', count: 44, x: 48, y: -4, shape: 'rect', shapeW: 104, shapeH: 4, dirMode: 'angle', angle: 90, spread: 14, speedMin: 40, speedMax: 54, wobble: 4, wobbleFreq: 0.8, lifeMin: 2, lifeMax: 2, pshape: 'circle', sizeStart: 2, sizeEnd: 2, sizeRand: 0.4, blend: 'normal', gradient: [st(0, '#ffffff', 0.95), st(1, '#dbe8ff', 0.95)] }),
        ],
      }),
  },
  {
    id: 'rain',
    label: '비 (루프)',
    make: () =>
      fx({
        name: '비',
        width: 96,
        height: 96,
        duration: 0.5,
        fps: 12,
        emitters: [
          em({ name: '빗줄기', count: 130, x: 48, y: -6, shape: 'rect', shapeW: 130, shapeH: 4, dirMode: 'angle', angle: 102, spread: 2, speedMin: 210, speedMax: 250, lifeMin: 0.5, lifeMax: 0.5, pshape: 'streak', sizeStart: 1, sizeEnd: 1, sizeRand: 0, streak: 0.045, blend: 'normal', gradient: [st(0, '#cfe2ff', 0.9), st(1, '#8fb4ff', 0.9)] }),
        ],
      }),
  },
  {
    id: 'sparkle',
    label: '반짝임 폭발',
    make: () =>
      fx({
        name: '반짝임',
        width: 64,
        height: 64,
        duration: 0.8,
        fps: 14,
        loop: false,
        emitters: [
          em({ name: '큰 별', mode: 'burst', count: 1, x: 32, y: 32, speedMin: 0, speedMax: 0, lifeMin: 0.4, lifeMax: 0.4, pshape: 'star', sizeStart: 32, sizeEnd: 0, sizeRand: 0, gradient: [st(0, '#ffffff'), st(1, '#ffd84a')] }),
          em({ name: '작은 별', mode: 'burst', count: 14, window: 0.1, x: 32, y: 32, dirMode: 'outward', speedMin: 14, speedMax: 44, drag: 2, lifeMin: 0.4, lifeMax: 0.8, pshape: 'star', sizeStart: 8, sizeEnd: 0, sizeRand: 0.3, gradient: [st(0, '#ffffff'), st(0.5, '#ffe66a'), st(1, '#ffa31a', 0.6)] }),
        ],
      }),
  },
  {
    id: 'splash',
    label: '물 튀김',
    make: () =>
      fx({
        name: '물튀김',
        width: 64,
        height: 64,
        duration: 0.8,
        fps: 16,
        loop: false,
        emitters: [
          em({ name: '물방울', mode: 'burst', count: 24, window: 0.05, x: 32, y: 48, shape: 'line', shapeW: 8, angle: -90, spread: 80, speedMin: 55, speedMax: 115, gravityY: 230, lifeMin: 0.45, lifeMax: 0.75, pshape: 'circle', sizeStart: 4, sizeEnd: 2, sizeRand: 0.3, blend: 'normal', gradient: [st(0, '#eafcff'), st(0.5, '#6cc6ff'), st(1, '#3a8cff', 0.5)] }),
          em({ name: '물결', mode: 'burst', count: 1, x: 32, y: 48, speedMin: 0, speedMax: 0, lifeMin: 0.5, lifeMax: 0.5, pshape: 'ring', sizeStart: 6, sizeEnd: 40, sizeRand: 0, blend: 'normal', gradient: [st(0, '#d8f4ff', 0.8), st(1, '#6cc6ff', 0)] }),
        ],
      }),
  },
];
