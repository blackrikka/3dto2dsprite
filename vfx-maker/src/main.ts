import './style.css';
import { Effect, Emitter, Stop, defaultEffect, defaultEmitter, sanitizeEffect } from './types';
import { Form, button, h } from './ui';
import { PRESETS } from './presets';
import { Raster, renderRaw } from './raster';
import { applyAlpha, outline, quantize } from './post';
import { PRESETS as PALETTES, RGB, hexToRgb, medianCut, parsePalette, presetPalette, rgbToHex } from './palette';
import { buildJson, buildSheet, buildZip, downloadBlob, encodeGif, layout, safeName, toBlob } from './exporter';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// 상태 / 저장
// ---------------------------------------------------------------------------
const EFFECT_KEY = 'vfxmaker.effect.v1';
const PREFS_KEY = 'vfxmaker.prefs.v1';

function readStore(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

const stored = readStore(EFFECT_KEY);
let fx: Effect = stored ? sanitizeEffect(stored) : PRESETS[0].make();
let sel = 0;
let playing = true;
let curFrame = 0;
let acc = 0;
let version = 0;

interface Prefs {
  bg: string;
  guide: boolean;
  scale: number;
  columns: number;
  pad: number;
}
const prefs: Prefs = { bg: 'checker', guide: true, scale: 1, columns: 0, pad: 0, ...(readStore(PREFS_KEY) as Partial<Prefs> | null) };
if (![1, 2, 4, 8].includes(prefs.scale)) prefs.scale = 1;
prefs.columns = Math.max(0, Math.min(64, Math.round(Number(prefs.columns) || 0)));
prefs.pad = Math.max(0, Math.min(16, Math.round(Number(prefs.pad) || 0)));

let saveTimer = 0;
function saveSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(EFFECT_KEY, JSON.stringify(fx));
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* 저장 불가 환경은 무시 */
    }
  }, 300);
}

function setStatus(msg: string, kind: '' | 'warn' | 'err' = ''): void {
  const s = $('status');
  s.textContent = msg;
  s.className = kind;
  s.title = msg;
}

const frameCount = () => Math.max(1, Math.min(240, Math.round(fx.duration * fx.fps)));
const curEm = (): Emitter | undefined => fx.emitters[sel];

// ---------------------------------------------------------------------------
// 렌더 파이프라인 (프레임 캐시)
// ---------------------------------------------------------------------------
let raster = new Raster(fx.width, fx.height);
const alphaCache = new Map<number, Uint8ClampedArray>();
const finalCache = new Map<number, Uint8ClampedArray>();
let autoPal: { v: number; pal: RGB[] } | null = null;

function touch(): void {
  version++;
  alphaCache.clear();
  finalCache.clear();
  autoPal = null;
  if (raster.w !== fx.width || raster.h !== fx.height) raster = new Raster(fx.width, fx.height);
  saveSoon();
  scheduleStrip();
}

function alphaFrame(i: number): Uint8ClampedArray {
  let a = alphaCache.get(i);
  if (!a) {
    a = applyAlpha(renderRaw(fx, i / fx.fps, raster), fx.width, fx.height, fx.post);
    alphaCache.set(i, a);
  }
  return a;
}

function getPalette(): RGB[] | null {
  const p = fx.post;
  switch (p.paletteMode) {
    case 'none': return null;
    case 'custom': {
      const c = parsePalette(p.customPalette);
      return c.length ? c : null;
    }
    case 'auto': {
      if (autoPal?.v !== version) {
        const n = frameCount(), k = Math.min(12, n);
        const samples: Uint8ClampedArray[] = [];
        for (let s = 0; s < k; s++) samples.push(alphaFrame(Math.floor((s * n) / k)));
        autoPal = { v: version, pal: medianCut(samples, p.colors) };
      }
      return autoPal.pal;
    }
    default: return presetPalette(p.paletteMode);
  }
}

function finalFrame(i: number): Uint8ClampedArray {
  let f = finalCache.get(i);
  if (!f) {
    f = new Uint8ClampedArray(alphaFrame(i));
    const pal = getPalette();
    showSwatches(pal);
    if (pal) quantize(f, pal);
    if (fx.post.outline) outline(f, fx.width, fx.height, hexToRgb(fx.post.outlineColor) ?? [0, 0, 0]);
    finalCache.set(i, f);
  }
  return f;
}

let swatchKey = '';
function showSwatches(pal: RGB[] | null): void {
  const key = pal ? pal.map(rgbToHex).join('') : '';
  if (key === swatchKey) return;
  swatchKey = key;
  const box = $('swatches');
  box.replaceChildren();
  (pal ?? []).forEach((c) => {
    const i = document.createElement('i');
    i.style.background = rgbToHex(c);
    i.title = rgbToHex(c);
    box.appendChild(i);
  });
  $('palCount').textContent = pal ? `${pal.length}색` : '제한 없음';
}

// ---------------------------------------------------------------------------
// 미리보기 캔버스 + 이미터 드래그 + 가이드
// ---------------------------------------------------------------------------
const pixelCanvas = $<HTMLCanvasElement>('pixel');
const pixelCtx = pixelCanvas.getContext('2d')!;
const gizmo = $<HTMLCanvasElement>('gizmo');
const box = $('canvasBox');
let drawnFrame: Uint8ClampedArray | null = null;
let viewScale = 1;
let gizmoKey = '';

function fitCanvas(): void {
  const stage = $('stage');
  viewScale = Math.max(1, Math.floor(Math.min((stage.clientWidth - 24) / fx.width, (stage.clientHeight - 24) / fx.height)));
  box.style.width = `${fx.width * viewScale}px`;
  box.style.height = `${fx.height * viewScale}px`;
  gizmoKey = '';
}
new ResizeObserver(fitCanvas).observe($('stage'));

function drawPreview(): void {
  const px = finalFrame(curFrame);
  if (pixelCanvas.width !== fx.width || pixelCanvas.height !== fx.height) {
    pixelCanvas.width = fx.width;
    pixelCanvas.height = fx.height;
    fitCanvas();
    drawnFrame = null;
  }
  if (px !== drawnFrame) {
    pixelCtx.putImageData(new ImageData(new Uint8ClampedArray(px), fx.width, fx.height), 0, 0);
    drawnFrame = px;
  }
}

/** 선택한 이미터의 위치와 모양을 겹쳐 그린다 (내보내기에는 포함되지 않는다) */
function drawGizmo(): void {
  const e = curEm();
  const key = [version, sel, prefs.guide, viewScale, e?.x, e?.y].join('|');
  if (key === gizmoKey) return;
  gizmoKey = key;
  const W = fx.width * viewScale, H = fx.height * viewScale;
  if (gizmo.width !== W || gizmo.height !== H) {
    gizmo.width = W;
    gizmo.height = H;
  }
  const g = gizmo.getContext('2d')!;
  g.clearRect(0, 0, W, H);
  if (!prefs.guide || !e) return;
  const s = viewScale, cx = e.x * s, cy = e.y * s, rot = (e.shapeRot * Math.PI) / 180;
  g.strokeStyle = '#ffffffcc';
  g.fillStyle = '#ff9a4d';
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  g.beginPath();
  switch (e.shape) {
    case 'circle': case 'ring': g.arc(cx, cy, e.shapeW * s, 0, Math.PI * 2); break;
    case 'arc': g.arc(cx, cy, e.shapeW * s, ((e.shapeRot - e.shapeH / 2) * Math.PI) / 180, ((e.shapeRot + e.shapeH / 2) * Math.PI) / 180); break;
    case 'line': g.moveTo(cx - (Math.cos(rot) * e.shapeW * s) / 2, cy - (Math.sin(rot) * e.shapeW * s) / 2); g.lineTo(cx + (Math.cos(rot) * e.shapeW * s) / 2, cy + (Math.sin(rot) * e.shapeW * s) / 2); break;
    case 'rect':
      g.save(); g.translate(cx, cy); g.rotate(rot); g.rect((-e.shapeW * s) / 2, (-e.shapeH * s) / 2, e.shapeW * s, e.shapeH * s); g.restore(); break;
    default: break;
  }
  g.stroke();
  g.setLineDash([]);
  g.beginPath();
  g.moveTo(cx - 7, cy); g.lineTo(cx + 7, cy); g.moveTo(cx, cy - 7); g.lineTo(cx, cy + 7);
  g.strokeStyle = '#000a'; g.lineWidth = 3; g.stroke();
  g.strokeStyle = '#ff9a4d'; g.lineWidth = 1.5; g.stroke();
}

// 캔버스를 드래그하면 선택한 이미터의 위치가 움직인다
let drag: { px: number; py: number; ex: number; ey: number } | null = null;
box.addEventListener('pointerdown', (ev) => {
  const e = curEm();
  if (!e) return;
  drag = { px: ev.clientX, py: ev.clientY, ex: e.x, ey: e.y };
  box.setPointerCapture(ev.pointerId);
});
box.addEventListener('pointermove', (ev) => {
  const e = curEm();
  if (!drag || !e) return;
  e.x = Math.round(drag.ex + (ev.clientX - drag.px) / viewScale);
  e.y = Math.round(drag.ey + (ev.clientY - drag.py) / viewScale);
  emitterForm.syncAll();
  touch();
});
box.addEventListener('pointerup', () => (drag = null));
box.addEventListener('pointercancel', () => (drag = null));

// ---------------------------------------------------------------------------
// 타임라인
// ---------------------------------------------------------------------------
const tl = $('tlControls');
const playBtn = button('⏸ 정지', '', () => setPlaying(!playing));
const scrub = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0' });
const frameLabel = h('span', { id: 'frameLabel' }, '');
tl.append(playBtn, scrub, frameLabel);
const strip = $('strip');

function setPlaying(p: boolean): void {
  playing = p;
  playBtn.textContent = p ? '⏸ 정지' : '▶ 재생';
  acc = curFrame / fx.fps;
}

function setFrame(i: number): void {
  const n = frameCount();
  curFrame = Math.max(0, Math.min(n - 1, i));
  scrub.max = String(n - 1);
  scrub.value = String(curFrame);
  frameLabel.textContent = `${curFrame + 1} / ${n} · ${(curFrame / fx.fps).toFixed(2)}초`;
  strip.querySelectorAll('canvas').forEach((c, k) => c.classList.toggle('sel', k === curFrame));
}
scrub.addEventListener('input', () => {
  setPlaying(false);
  setFrame(Number(scrub.value));
});

let stripToken = 0;
let stripRaf = 0;
function scheduleStrip(): void {
  cancelAnimationFrame(stripRaf);
  stripRaf = requestAnimationFrame(() => void regenStrip());
}
async function regenStrip(): Promise<void> {
  const token = ++stripToken;
  const n = frameCount(), { width: w, height: hh } = fx;
  let canvases = [...strip.querySelectorAll('canvas')];
  if (canvases.length !== n || canvases.some((c) => c.width !== w || c.height !== hh)) {
    strip.replaceChildren();
    canvases = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = hh;
      c.title = `프레임 ${i + 1}`;
      c.addEventListener('click', () => { setPlaying(false); setFrame(i); });
      strip.appendChild(c);
      canvases.push(c);
    }
  }
  setFrame(Math.min(curFrame, n - 1));
  updateInfo();
  for (let i = 0; i < n; i++) {
    if (token !== stripToken) return;
    canvases[i].getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(finalFrame(i)), w, hh), 0, 0);
    if (i % 6 === 5) await nextFrame();
  }
}

function updateInfo(): void {
  const n = frameCount();
  const L = layout(n, fx.width, fx.height, prefs.scale, prefs.columns, prefs.pad);
  $('previewInfo').textContent = `${fx.width}×${fx.height}px · ${n}프레임 · ${fx.duration}초 @${fx.fps}fps → 시트 ${L.width}×${L.height}px`;
}

// ---------------------------------------------------------------------------
// 패널
// ---------------------------------------------------------------------------
const panel = $('panel');
const effectForm = new Form(() => fx as unknown as Record<string, unknown>, (key) => {
  if (key === 'width' || key === 'height') { fitCanvas(); drawnFrame = null; }
  if (key === 'duration' || key === 'fps') setFrame(curFrame);
  touch();
  updateInfo();
});
const emitterForm = new Form(() => curEm() as unknown as Record<string, unknown>, () => touch());
const postForm = new Form(() => fx.post as unknown as Record<string, unknown>, () => { updatePostUi(); touch(); });
const exportForm = new Form(() => prefs as unknown as Record<string, unknown>, () => { updateInfo(); saveSoon(); });

let customCtl: ReturnType<Form['textarea']>;
let colorsCtl: ReturnType<Form['slider']>;
let thrCtl: ReturnType<Form['slider']>;
const emlist = h('div', { class: 'emlist' });
const gradBox = h('div', { class: 'grad' });
let exportBtns: HTMLButtonElement[] = [];

function updatePostUi(): void {
  const p = fx.post;
  customCtl.row.style.display = p.paletteMode === 'custom' ? '' : 'none';
  colorsCtl.row.style.display = p.paletteMode === 'auto' ? '' : 'none';
  thrCtl.row.style.display = p.alphaMode === 'threshold' ? '' : 'none';
}

function selectEmitter(i: number): void {
  sel = Math.max(0, Math.min(fx.emitters.length - 1, i));
  renderEmitterList();
  emitterForm.syncAll();
  renderGradient();
  gizmoKey = '';
}

function renderEmitterList(): void {
  emlist.replaceChildren();
  fx.emitters.forEach((e, i) => {
    const en = h('input', { type: 'checkbox' });
    en.checked = e.enabled;
    en.title = '켜기/끄기';
    en.addEventListener('change', () => { e.enabled = en.checked; touch(); });
    const nm = button(e.name || '이미터', 'nm', () => selectEmitter(i));
    const mv = (d: number) => {
      const j = i + d;
      if (j < 0 || j >= fx.emitters.length) return;
      [fx.emitters[i], fx.emitters[j]] = [fx.emitters[j], fx.emitters[i]];
      sel = j;
      renderEmitterList();
      touch();
    };
    const row = h('div', { class: `emrow${i === sel ? ' sel' : ''}` }, en, nm,
      button('↑', 'icon small', () => mv(-1)),
      button('↓', 'icon small', () => mv(1)),
      button('⧉', 'icon small', () => {
        const c = JSON.parse(JSON.stringify(e)) as Emitter;
        c.name = `${e.name} 복사`;
        fx.emitters.splice(i + 1, 0, c);
        selectEmitter(i + 1);
        touch();
      }),
      button('✕', 'icon small', () => {
        if (fx.emitters.length <= 1) return setStatus('이미터가 하나는 있어야 합니다.', 'warn');
        fx.emitters.splice(i, 1);
        selectEmitter(Math.min(sel, fx.emitters.length - 1));
        touch();
      }),
    );
    emlist.appendChild(row);
  });
}

// --- 그라디언트 편집기 ---
function renderGradient(): void {
  gradBox.replaceChildren();
  const e = curEm();
  if (!e) return;
  const bar = h('canvas');
  bar.width = 256;
  bar.height = 18;
  const drawBar = () => {
    const g = bar.getContext('2d')!;
    g.clearRect(0, 0, 256, 18);
    for (let x = 0; x < 256; x++) {
      const u = x / 255;
      const s = e.gradient;
      let a = s[0], b = s[s.length - 1];
      for (let i = 1; i < s.length; i++) if (u <= s[i].t) { a = s[i - 1]; b = s[i]; break; }
      const k = u <= s[0].t ? 0 : u >= s[s.length - 1].t ? 1 : b.t === a.t ? 0 : (u - a.t) / (b.t - a.t);
      const ca = hexToRgb(a.color) ?? [255, 255, 255], cb = hexToRgb(b.color) ?? [255, 255, 255];
      const lerp = (p: number, q: number) => Math.round(p + (q - p) * k);
      const al = u <= s[0].t ? s[0].a : u >= s[s.length - 1].t ? s[s.length - 1].a : a.a + (b.a - a.a) * k;
      g.fillStyle = `rgba(${lerp(ca[0], cb[0])},${lerp(ca[1], cb[1])},${lerp(ca[2], cb[2])},${al})`;
      g.fillRect(x, 0, 1, 18);
    }
  };
  drawBar();
  gradBox.appendChild(bar);
  const list = h('div', { class: 'section-body', style: 'padding:6px 0 0' });
  const rerender = () => { e.gradient.sort((a: Stop, b: Stop) => a.t - b.t); renderGradient(); touch(); };
  e.gradient.forEach((s, i) => {
    const c = h('input', { type: 'color' });
    c.value = s.color;
    c.addEventListener('input', () => { s.color = c.value; drawBar(); touch(); });
    const a = h('input', { type: 'range', min: '0', max: '1', step: '0.01' });
    a.value = String(s.a);
    a.title = '불투명도';
    a.addEventListener('input', () => { s.a = Number(a.value); drawBar(); touch(); });
    const t = h('input', { type: 'range', min: '0', max: '1', step: '0.01' });
    t.value = String(s.t);
    t.title = '위치(수명 비율)';
    t.addEventListener('input', () => { s.t = Number(t.value); drawBar(); touch(); });
    t.addEventListener('change', rerender);
    const del = button('✕', 'icon small', () => {
      if (e.gradient.length <= 2) return setStatus('색 지점은 최소 2개가 필요합니다.', 'warn');
      e.gradient.splice(i, 1);
      rerender();
    });
    list.appendChild(h('div', { class: 'stop' }, c, a, t, del));
  });
  list.appendChild(
    button('+ 색 지점 추가', 'small', () => {
      if (e.gradient.length >= 8) return setStatus('색 지점은 최대 8개입니다.', 'warn');
      const mid = e.gradient[Math.floor(e.gradient.length / 2)];
      e.gradient.push({ t: Math.min(1, mid.t + 0.1), color: mid.color, a: mid.a });
      rerender();
    }),
  );
  gradBox.appendChild(list);
  gradBox.appendChild(h('p', { class: 'hint' }, '각 줄: 색 · 불투명도 · 위치(0=발생 … 1=소멸)'));
}

function buildPanel(): void {
  // --- 이펙트
  const sec = effectForm.section(panel, '이펙트');
  effectForm.text(sec, '이름', 'name');
  const presetSel = h('select');
  presetSel.appendChild(new Option('프리셋 선택…', ''));
  PRESETS.forEach((p) => presetSel.appendChild(new Option(p.label, p.id)));
  presetSel.addEventListener('change', () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    presetSel.value = '';
    if (!p) return;
    loadEffect(p.make(), `프리셋 "${p.label}"을 불러왔습니다.`);
  });
  sec.appendChild(h('label', { class: 'row col' }, h('span', { class: 'lbl' }, '프리셋 불러오기 (현재 이펙트를 대체)'), presetSel));
  const sizes = h('div', { class: 'btn-row' });
  for (const n of [32, 48, 64, 96, 128, 192, 256]) {
    sizes.appendChild(button(String(n), 'small', () => {
      fx.width = fx.height = n;
      effectForm.syncAll();
      fitCanvas();
      drawnFrame = null;
      touch();
      updateInfo();
    }));
  }
  sec.append(h('span', { class: 'hint' }, '해상도 프리셋 (정사각)'), sizes);
  effectForm.number(sec, '가로(px)', 'width', 8, 512);
  effectForm.number(sec, '세로(px)', 'height', 8, 512);
  effectForm.slider(sec, '길이(초)', 'duration', 0.1, 6, 0.05, (v) => `${v.toFixed(2)}s`);
  effectForm.slider(sec, 'FPS', 'fps', 1, 60, 1);
  effectForm.check(sec, '루프 (끊김 없이 반복되게 계산)', 'loop');
  const seedRow = h('div', { class: 'btn-row' });
  effectForm.number(sec, '시드', 'seed', 0, 99999);
  seedRow.appendChild(button('🎲 시드 바꾸기', 'small', () => {
    fx.seed = Math.floor(Math.random() * 99999);
    effectForm.syncAll();
    touch();
  }));
  sec.append(seedRow, h('p', { class: 'hint' }, '시드가 같으면 언제나 같은 모양이 나옵니다. 루프가 켜져 있으면 입자 수명은 길이를 넘지 않게 제한됩니다.'));

  // --- 이미터
  const secE = emitterForm.section(panel, '이미터 (레이어)');
  secE.append(emlist);
  secE.appendChild(button('+ 이미터 추가', 'small', () => {
    const e = defaultEmitter();
    e.name = `이미터 ${fx.emitters.length + 1}`;
    e.x = Math.round(fx.width / 2);
    e.y = Math.round(fx.height / 2);
    fx.emitters.push(e);
    selectEmitter(fx.emitters.length - 1);
    touch();
  }));
  secE.appendChild(h('p', { class: 'hint' }, '위에 있는 이미터가 먼저(아래쪽에) 그려집니다. 미리보기를 드래그하면 선택한 이미터가 움직입니다.'));
  emitterForm.text(secE, '이름', 'name');

  const gen = emitterForm.section(secE, '발생', true, true);
  emitterForm.select(gen, '방식', 'mode', [['continuous', '지속 (초당 N개)'], ['burst', '한 번에 (N개)']]);
  emitterForm.slider(gen, '개수', 'count', 1, 400, 1);
  emitterForm.slider(gen, '시작 시각', 'start', 0, 6, 0.01, (v) => `${v.toFixed(2)}s`);
  emitterForm.slider(gen, '시간 폭', 'window', 0, 6, 0.01, (v) => (v === 0 ? '자동' : `${v.toFixed(2)}s`));
  gen.appendChild(h('p', { class: 'hint' }, '한 번에: 시간 폭 동안 퍼뜨려 발생(0=동시). 지속: 시간 폭 동안(0=끝까지) 발생.'));

  const pos = emitterForm.section(secE, '위치 · 모양', true, true);
  emitterForm.number(pos, 'X (px)', 'x', -256, 768);
  emitterForm.number(pos, 'Y (px)', 'y', -256, 768);
  emitterForm.select(pos, '발생 모양', 'shape', [['point', '점'], ['circle', '원(채움)'], ['ring', '원(테두리)'], ['arc', '호'], ['line', '선'], ['rect', '사각형']]);
  emitterForm.slider(pos, '크기 W / 반지름', 'shapeW', 0, 256, 1);
  emitterForm.slider(pos, '크기 H / 호 각도', 'shapeH', 0, 360, 1);
  emitterForm.slider(pos, '회전(°)', 'shapeRot', -180, 180, 1);
  emitterForm.check(pos, '순서대로 배치 (슬래시·빔·링 확장)', 'sweep');

  const mov = emitterForm.section(secE, '움직임', false, true);
  emitterForm.select(mov, '방향 기준', 'dirMode', [['angle', '고정 각도'], ['outward', '바깥쪽'], ['inward', '안쪽'], ['tangent', '접선(회전)']]);
  emitterForm.slider(mov, '각도(°)', 'angle', -180, 180, 1);
  emitterForm.slider(mov, '퍼짐(°)', 'spread', 0, 360, 1);
  emitterForm.slider(mov, '속도 최소', 'speedMin', 0, 400, 1);
  emitterForm.slider(mov, '속도 최대', 'speedMax', 0, 400, 1);
  emitterForm.slider(mov, '중력 X', 'gravityX', -400, 400, 1);
  emitterForm.slider(mov, '중력 Y', 'gravityY', -400, 400, 1);
  emitterForm.slider(mov, '저항', 'drag', 0, 10, 0.05, (v) => v.toFixed(2));
  emitterForm.slider(mov, '흔들림', 'wobble', 0, 30, 0.5);
  emitterForm.slider(mov, '흔들림 속도', 'wobbleFreq', 0, 10, 0.1, (v) => `${v.toFixed(1)}Hz`);
  emitterForm.slider(mov, '수명 최소', 'lifeMin', 0.05, 6, 0.01, (v) => `${v.toFixed(2)}s`);
  emitterForm.slider(mov, '수명 최대', 'lifeMax', 0.05, 6, 0.01, (v) => `${v.toFixed(2)}s`);

  const look = emitterForm.section(secE, '입자 모양 · 색', true, true);
  emitterForm.select(look, '모양', 'pshape', [['square', '네모'], ['circle', '원'], ['glow', '빛(부드러움)'], ['diamond', '마름모'], ['plus', '십자'], ['star', '별'], ['ring', '링'], ['streak', '꼬리(속도 방향)']]);
  emitterForm.slider(look, '크기 시작', 'sizeStart', 0, 120, 0.5);
  emitterForm.slider(look, '크기 끝', 'sizeEnd', 0, 120, 0.5);
  emitterForm.slider(look, '크기 무작위', 'sizeRand', 0, 1, 0.01, (v) => v.toFixed(2));
  emitterForm.slider(look, '꼬리 길이', 'streak', 0.01, 0.3, 0.005, (v) => `${v.toFixed(3)}s`);
  emitterForm.select(look, '합성', 'blend', [['add', '가산 (밝게, 불·빛)'], ['normal', '일반 (연기·물)']]);
  emitterForm.slider(look, '서서히 나타남', 'fadeIn', 0, 1, 0.01, (v) => v.toFixed(2));
  emitterForm.slider(look, '서서히 사라짐', 'fadeOut', 0, 1, 0.01, (v) => v.toFixed(2));
  look.appendChild(gradBox);

  // --- 후처리
  const secP = postForm.section(panel, '도트 후처리');
  postForm.select(secP, '반투명 처리', 'alphaMode', [['dither', '디더 (성기게 표현, 도트 느낌)'], ['threshold', '이진화'], ['keep', '그대로 (반투명 유지)']]);
  thrCtl = postForm.slider(secP, '알파 임계값', 'alphaThreshold', 1, 255, 1);
  postForm.select(secP, '팔레트', 'paletteMode', [
    ['auto', '자동 추출'],
    ...Object.entries(PALETTES).map(([k, v]) => [k, v.label] as [string, string]),
    ['custom', '직접 입력'],
    ['none', '제한 없음'],
  ]);
  colorsCtl = postForm.slider(secP, '색상 수', 'colors', 2, 64, 1);
  customCtl = postForm.textarea(secP, '색상 목록 (#rrggbb)', 'customPalette');
  secP.append(h('div', { class: 'hint' }, '사용 중인 팔레트: ', h('b', { id: 'palCount' })), h('div', { id: 'swatches' }));
  postForm.check(secP, '외곽선', 'outline');
  postForm.color(secP, '외곽선 색', 'outlineColor');

  // --- 내보내기
  const secX = exportForm.section(panel, '내보내기');
  exportForm.select(secX, '출력 배율', 'scale', [['1', '×1 (원본 픽셀)'], ['2', '×2'], ['4', '×4'], ['8', '×8']]);
  exportForm.number(secX, '시트 열 수', 'columns', 0, 64);
  exportForm.number(secX, '프레임 간격(px)', 'pad', 0, 16);
  secX.appendChild(h('p', { class: 'hint' }, '열 수 0 = 한 줄. 간격은 프레임 둘레의 투명 여백입니다.'));
  const bx = h('div', { class: 'btn-row' });
  bx.append(
    button('시트 PNG + JSON', 'primary', () => void doExport('sheet')),
    button('GIF', '', () => void doExport('gif')),
    button('프레임 PNG (zip)', '', () => void doExport('zip')),
    button('현재 프레임 PNG', '', () => void doExport('frame')),
  );
  exportBtns = [...bx.querySelectorAll('button')];
  secX.append(bx, h('p', { class: 'hint' }, 'JSON 은 Aseprite/TexturePacker(hash) 호환이며 frameTags 와 fps, loop 정보가 들어 있습니다.'));

  // --- 파일
  const secF = effectForm.section(panel, '파일', false);
  const fb = h('div', { class: 'btn-row' });
  const fileLoad = $<HTMLInputElement>('fileLoad');
  fileLoad.addEventListener('change', async () => {
    const f = fileLoad.files?.[0];
    fileLoad.value = '';
    if (!f) return;
    try {
      loadEffect(sanitizeEffect(JSON.parse(await f.text())), `불러옴: ${f.name}`);
    } catch {
      setStatus('이펙트 파일을 읽을 수 없습니다.', 'err');
    }
  });
  fb.append(
    button('이펙트 저장(.vfx.json)', '', () => downloadBlob(new Blob([JSON.stringify(fx, null, 2)], { type: 'application/json' }), `${safeName(fx.name)}.vfx.json`)),
    button('이펙트 불러오기', '', () => fileLoad.click()),
    button('새 이펙트', '', () => loadEffect(defaultEffect(), '새 이펙트를 만들었습니다.')),
  );
  secF.append(fb, h('p', { class: 'hint' }, '작업 내용은 자동 저장되어 다음 실행 때 복원됩니다.'));

  updatePostUi();
  renderEmitterList();
  renderGradient();
}

function loadEffect(next: Effect, msg: string): void {
  fx = next;
  sel = 0;
  curFrame = 0;
  acc = 0;
  effectForm.syncAll();
  postForm.syncAll();
  emitterForm.syncAll();
  renderEmitterList();
  renderGradient();
  updatePostUi();
  fitCanvas();
  drawnFrame = null;
  touch();
  setFrame(0);
  updateInfo();
  setStatus(msg);
}

// ---------------------------------------------------------------------------
// 미리보기 헤더 컨트롤
// ---------------------------------------------------------------------------
function buildPreviewCtl(): void {
  const bgSel = h('select', { class: 'mini' });
  for (const [v, t] of [['checker', '체크무늬'], ['dark', '어두운 배경'], ['light', '밝은 배경'], ['sky', '하늘색'], ['green', '크로마키 초록'], ['magenta', '마젠타']]) bgSel.appendChild(new Option(t, v));
  const apply = () => { $('stage').className = `bg-${prefs.bg}`; };
  bgSel.value = prefs.bg;
  bgSel.addEventListener('change', () => { prefs.bg = bgSel.value; apply(); saveSoon(); });
  apply();
  const guide = h('input', { type: 'checkbox' });
  guide.checked = prefs.guide;
  guide.addEventListener('change', () => { prefs.guide = guide.checked; gizmoKey = ''; saveSoon(); });
  $('previewCtl').append(h('label', { class: 'chk' }, guide, '가이드'), bgSel);
}

// ---------------------------------------------------------------------------
// 내보내기
// ---------------------------------------------------------------------------
async function gatherFrames(): Promise<Uint8ClampedArray[]> {
  const n = frameCount(), out: Uint8ClampedArray[] = [];
  for (let i = 0; i < n; i++) {
    out.push(finalFrame(i));
    if (i % 12 === 11) await nextFrame();
  }
  return out;
}

async function doExport(kind: 'sheet' | 'gif' | 'zip' | 'frame'): Promise<void> {
  const base = safeName(fx.name);
  exportBtns.forEach((b) => (b.disabled = true));
  try {
    setStatus('내보내는 중…');
    await nextFrame();
    const { width: w, height: hh } = fx;
    if (kind === 'frame') {
      const c = buildSheet([finalFrame(curFrame)], w, hh, prefs.scale, 0, 0);
      const name = `${base}_${String(curFrame).padStart(2, '0')}.png`;
      downloadBlob(await toBlob(c), name);
      return setStatus(`프레임 저장: ${name}`);
    }
    const frames = await gatherFrames();
    if (kind === 'sheet') {
      const sheet = buildSheet(frames, w, hh, prefs.scale, prefs.columns, prefs.pad);
      const png = `${base}_sheet.png`;
      downloadBlob(await toBlob(sheet), png);
      downloadBlob(
        new Blob([buildJson({ name: base, image: png, w, h: hh, scale: prefs.scale, count: frames.length, fps: fx.fps, columns: prefs.columns, pad: prefs.pad, loop: fx.loop })], { type: 'application/json' }),
        `${base}_sheet.json`,
      );
      setStatus(`시트 저장: ${png} (${sheet.width}×${sheet.height}px, ${frames.length}프레임) + JSON`);
    } else if (kind === 'zip') {
      downloadBlob(new Blob([(await buildZip(frames, w, hh, prefs.scale, base)) as BlobPart], { type: 'application/zip' }), `${base}_frames.zip`);
      setStatus(`zip 저장: ${base}_frames.zip (${frames.length}장)`);
    } else {
      downloadBlob(new Blob([encodeGif(frames, w, hh, prefs.scale, fx.fps, fx.loop) as BlobPart], { type: 'image/gif' }), `${base}.gif`);
      setStatus(`GIF 저장: ${base}.gif`);
    }
  } catch (e) {
    console.error(e);
    setStatus(`내보내기 실패: ${(e as Error).message}`, 'err');
  } finally {
    exportBtns.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------------------
// 키보드 / 메인 루프
// ---------------------------------------------------------------------------
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && (t as HTMLInputElement).type !== 'range') return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!playing);
  } else if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
    e.preventDefault();
    setPlaying(false);
    const n = frameCount();
    setFrame((curFrame + (e.code === 'ArrowRight' ? 1 : -1) + n) % n);
  }
});

let last = performance.now();
function tick(now: number): void {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  try {
    const n = frameCount();
    if (playing && n > 1) {
      acc += dt;
      const f = Math.floor(acc * fx.fps) % n;
      if (f !== curFrame) setFrame(f);
    }
    drawPreview();
    drawGizmo();
  } catch (e) {
    console.error(e);
    setStatus(`렌더링 오류: ${(e as Error).message}`, 'err');
  }
  requestAnimationFrame(tick);
}

buildPanel();
buildPreviewCtl();
fitCanvas();
touch();
setFrame(0);
updateInfo();
requestAnimationFrame(tick);

(window as unknown as Record<string, unknown>).__app = {
  get fx() { return fx; },
  loadEffect,
  frame: (i: number) => finalFrame(i),
  rawAt: (T: number) => renderRaw(fx, T, new Raster(fx.width, fx.height)),
  frameCount,
  setPlaying,
  setFrame,
  PRESETS,
};
