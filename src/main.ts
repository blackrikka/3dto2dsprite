import './style.css';
import { Stage } from './stage';
import { DEFAULTS, Settings, dirName } from './types';
import { Form, button, h } from './ui';
import { PRESETS, RGB, medianCut, parsePalette, presetPalette, rgbToHex } from './palette';
import { prepare, processFrame } from './pixelate';
import { MAIN_EXT, ext, loadModelFiles, loadVmd } from './loaders';
import { createSampleCharacter } from './sample';
import { IMAGE_EXT, ImageSource } from './imagesource';
import { SD_PRESETS, headCount } from './proportions';
import { Frames, buildJson, buildSheet, buildZip, downloadBlob, encodeGif, safeName, toBlob } from './exporter';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

// ---------------------------------------------------------------------------
// 설정 저장/복원 (localStorage) — 읽기/쓰기 실패(비공개 모드 등)는 조용히 무시한다.
// ---------------------------------------------------------------------------
const SETTINGS_KEY = 'sprite3d2d.settings.v1';
const PREFS_KEY = 'sprite3d2d.prefs.v1';

function sanitizeSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const o = out as unknown as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS)) {
    const v = r[k];
    if (typeof v === typeof o[k] && !(typeof v === 'number' && !Number.isFinite(v))) o[k] = v;
  }
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, Math.round(v)));
  out.width = clamp(out.width, 8, 512);
  out.height = clamp(out.height, 8, 512);
  out.fps = clamp(out.fps, 1, 60);
  out.frameCount = clamp(out.frameCount, 1, 240);
  out.colors = clamp(out.colors, 2, 64);
  out.toonSteps = clamp(out.toonSteps, 2, 6);
  out.sheetPadding = clamp(out.sheetPadding, 0, 16);
  out.imgCols = clamp(out.imgCols, 1, 64);
  out.imgRows = clamp(out.imgRows, 1, 64);
  out.imgMargin = clamp(out.imgMargin, 0, 16);
  out.imgBgTolerance = clamp(out.imgBgTolerance, 0, 100);
  out.imgBgEdge = clamp(out.imgBgEdge, 0, 4);
  if (!['box', 'mode', 'nearest'].includes(out.imgAlgo)) out.imgAlgo = DEFAULTS.imgAlgo;
  if (!['contain', 'cover', 'stretch'].includes(out.imgFit)) out.imgFit = DEFAULTS.imgFit;
  if (!['center', 'bottom'].includes(out.imgAlign)) out.imgAlign = DEFAULTS.imgAlign;
  out.source = 'model'; // 입력 소스는 저장하지 않고 항상 3D 로 시작 (이미지는 매번 다시 불러와야 하므로)
  const clampF = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  out.sdHead = clampF(out.sdHead, 1, 3.5);
  out.sdTorso = clampF(out.sdTorso, 0.3, 1.2);
  out.sdArm = clampF(out.sdArm, 0.3, 1.2);
  out.sdLeg = clampF(out.sdLeg, 0.25, 1.2);
  if (![1, 4, 8, 16].includes(out.directions)) out.directions = DEFAULTS.directions;
  if (![1, 2, 4, 8].includes(out.exportScale)) out.exportScale = DEFAULTS.exportScale;
  if (!['auto', 'pico8', 'gameboy', 'sweetie16', 'custom', 'none'].includes(out.paletteMode)) out.paletteMode = DEFAULTS.paletteMode;
  if (!['original', 'toon'].includes(out.shading)) out.shading = DEFAULTS.shading;
  return out;
}

function readStore(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

interface Prefs {
  view: 'single' | 'all';
  bg: 'checker' | 'dark' | 'light' | 'green' | 'magenta';
}
const BG_LABELS: [Prefs['bg'], string][] = [
  ['checker', '체크무늬'], ['dark', '어두운 배경'], ['light', '밝은 배경'], ['green', '초록(크로마키)'], ['magenta', '마젠타'],
];
const prefs: Prefs = { view: 'single', bg: 'checker', ...(readStore(PREFS_KEY) as Partial<Prefs> | null) };
if (!['single', 'all'].includes(prefs.view)) prefs.view = 'single';
if (!BG_LABELS.some(([k]) => k === prefs.bg)) prefs.bg = 'checker';

const settings: Settings = sanitizeSettings(readStore(SETTINGS_KEY));
let saveTimer = 0;
function saveSoon(): void {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* 저장 불가 환경: 무시 */
    }
  }, 300);
}

const stage = new Stage($('viewport'));
const imgSrc = new ImageSource();
const isImage = () => settings.source === 'image';
/** 방향 수: 3D 모드는 설정값, 이미지 모드는 시트의 행 수 */
const dirCount = () => (isImage() ? (imgSrc.prepare(settings)?.rows ?? 1) : settings.directions);
const dirLabel = (d: number) => (isImage() ? `row${d + 1}` : dirName(d, settings.directions));
const pixelCanvas = $<HTMLCanvasElement>('pixel');
const pixelCtx = pixelCanvas.getContext('2d')!;

let curDir = 0;
let curFrame = 0;
let playing = true;
let acc = 0;

// ---------------------------------------------------------------------------
// 상태 표시
// ---------------------------------------------------------------------------
function setStatus(msg: string, kind: '' | 'warn' | 'err' = ''): void {
  const s = $('status');
  s.textContent = msg;
  s.className = kind;
  s.title = msg;
}

// ---------------------------------------------------------------------------
// 프레임/캐시
// ---------------------------------------------------------------------------
function frameCount(): number {
  if (isImage()) return Math.max(1, Math.min(240, imgSrc.prepare(settings)?.cols ?? 1));
  if (!settings.autoFrames) return Math.max(1, Math.min(240, Math.round(settings.frameCount)));
  const d = stage.duration;
  return d > 0 ? Math.max(1, Math.min(240, Math.round(d * settings.fps))) : 1;
}

/** 프레임 i 의 애니메이션 시간. 루프면 마지막 프레임이 첫 프레임과 겹치지 않도록 한다. */
function frameTime(i: number): number {
  const d = stage.duration, n = frameCount();
  if (d <= 0 || n <= 1) return 0;
  return settings.loop ? (i / n) * d : (i / (n - 1)) * d;
}

function rawKey(): string {
  const s = settings;
  if (isImage()) {
    return [
      'img', imgSrc.version, s.width, s.height, dirCount(), frameCount(), s.imgCols, s.imgRows, s.imgAlgo, s.imgFit,
      s.imgAlign, s.imgTrim, s.imgMargin, s.imgBgRemove, s.imgBgTolerance, s.imgBgEdge, s.imgBgGlobal,
    ].join('|');
  }
  return [
    stage.modelVersion, stage.activeClip, s.width, s.height, s.directions, frameCount(), s.loop,
    s.pitch, s.zoom, s.offsetX, s.offsetY, s.inPlace, s.shading, s.toonSteps,
    s.sdEnabled, s.sdHead, s.sdTorso, s.sdArm, s.sdLeg,
    s.lightAzimuth, s.lightElevation, s.lightIntensity, s.ambient,
  ].join('|');
}

let curRawKey = '';
const rawCache = new Map<string, Uint8ClampedArray>();
let procKey = '';
const procCache = new Map<string, Uint8ClampedArray>();
let autoPal: { key: string; pal: RGB[] } | null = null;

/** 3D 쪽 설정이 바뀌었으면 스테이지를 다시 구성하고 캐시를 비운다. */
function ensureStage(): void {
  const k = rawKey();
  if (k === curRawKey) return;
  curRawKey = k;
  rawCache.clear();
  procCache.clear();
  autoPal = null;
  if (!isImage()) stage.configure(settings);
}

function getRaw(d: number, i: number): Uint8ClampedArray {
  const k = `${d}:${i}`;
  let r = rawCache.get(k);
  if (!r) {
    if (isImage()) {
      r = imgSrc.render(d, i, settings);
    } else {
      stage.setPose(d, settings.directions, frameTime(i));
      r = stage.renderRaw(settings.width, settings.height);
    }
    rawCache.set(k, r);
  }
  return r;
}

function getPalette(): RGB[] | null {
  const s = settings;
  switch (s.paletteMode) {
    case 'none':
      return null;
    case 'custom': {
      const p = parsePalette(s.customPalette);
      return p.length ? p : null;
    }
    case 'auto': {
      const key = [curRawKey, s.colors, s.saturation, s.contrast, s.brightness, s.alphaThreshold].join('|');
      if (autoPal?.key !== key) {
        const dirs = dirCount();
        const dsel = dirs >= 4 ? [0, dirs / 4, dirs / 2, (dirs * 3) / 4].map(Math.floor) : [0];
        const n = frameCount();
        const fn = Math.min(8, n);
        const samples: Uint8ClampedArray[] = [];
        for (const d of dsel) {
          for (let k = 0; k < fn; k++) samples.push(prepare(getRaw(d, Math.floor((k * n) / fn)), s));
        }
        autoPal = { key, pal: medianCut(samples, s.colors) };
      }
      return autoPal.pal;
    }
    default:
      return presetPalette(s.paletteMode);
  }
}

/** 처리가 끝난(팔레트/외곽선까지 적용된) 프레임 */
function getFrame(d: number, i: number): Uint8ClampedArray {
  ensureStage();
  const pk = curRawKey + JSON.stringify(settings);
  if (pk !== procKey) {
    procKey = pk;
    procCache.clear();
  }
  const k = `${d}:${i}`;
  let px = procCache.get(k);
  if (!px) {
    const pal = getPalette();
    showSwatches(pal);
    px = processFrame(getRaw(d, i), settings.width, settings.height, settings, pal);
    procCache.set(k, px);
  }
  return px;
}

// ---------------------------------------------------------------------------
// 팔레트 스와치
// ---------------------------------------------------------------------------
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
// 미리보기/타임라인
// ---------------------------------------------------------------------------
let lastDrawn: Uint8ClampedArray[] = [];
let lastDrawnSize = '';

const allCols = () => Math.min(4, dirCount());

function drawPreview(): void {
  const dirs = prefs.view === 'all' ? Array.from({ length: dirCount() }, (_, d) => d) : [curDir];
  const frames = dirs.map((d) => getFrame(d, curFrame));
  const { width: w, height: h } = settings;
  const cols = prefs.view === 'all' ? allCols() : 1;
  const rows = Math.ceil(dirs.length / cols);
  const size = `${cols * w}x${rows * h}`;
  if (size === lastDrawnSize && frames.length === lastDrawn.length && frames.every((f, i) => f === lastDrawn[i])) return;
  if (pixelCanvas.width !== cols * w || pixelCanvas.height !== rows * h) {
    pixelCanvas.width = cols * w;
    pixelCanvas.height = rows * h;
    fitPixelCanvas();
  }
  frames.forEach((px, i) => {
    pixelCtx.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), (i % cols) * w, Math.floor(i / cols) * h);
  });
  lastDrawn = frames;
  lastDrawnSize = size;
}

function fitPixelCanvas(): void {
  const wrap = $('pixelWrap');
  const { width: cw, height: ch } = pixelCanvas;
  const scale = Math.max(1, Math.floor(Math.min((wrap.clientWidth - 16) / cw, (wrap.clientHeight - 16) / ch)));
  pixelCanvas.style.width = `${cw * scale}px`;
  pixelCanvas.style.height = `${ch * scale}px`;
}

// 전체 방향 보기에서 타일을 클릭하면 그 방향을 선택
pixelCanvas.addEventListener('click', (e) => {
  if (prefs.view !== 'all') return;
  const r = pixelCanvas.getBoundingClientRect();
  const cols = allCols(), rows = Math.ceil(dirCount() / cols);
  const d = Math.floor(((e.clientY - r.top) / r.height) * rows) * cols + Math.floor(((e.clientX - r.left) / r.width) * cols);
  if (d >= 0 && d < dirCount() && d !== curDir) {
    curDir = d;
    rebuildDirButtons();
    scheduleStrip();
  }
});

new ResizeObserver(fitPixelCanvas).observe($('pixelWrap'));

const tl = $('tlControls');
const playBtn = button('⏸ 정지', '', () => setPlaying(!playing));
const scrub = h('input', { type: 'range', min: '0', max: '0', step: '1', value: '0' });
const frameLabel = h('span', { id: 'frameLabel' }, '1 / 1');
const dirBox = h('div', { class: 'dirs' });
tl.append(playBtn, scrub, frameLabel, h('span', { class: 'hint' }, '방향'), dirBox);

function setPlaying(p: boolean): void {
  playing = p;
  playBtn.textContent = p ? '⏸ 정지' : '▶ 재생';
  acc = curFrame / settings.fps;
}

function setFrame(i: number): void {
  const n = frameCount();
  curFrame = Math.max(0, Math.min(n - 1, i));
  scrub.max = String(n - 1);
  scrub.value = String(curFrame);
  frameLabel.textContent = `${curFrame + 1} / ${n}`;
  strip.querySelectorAll('canvas').forEach((c, k) => c.classList.toggle('sel', k === curFrame));
}

scrub.addEventListener('input', () => {
  setPlaying(false);
  setFrame(Number(scrub.value));
});

function rebuildDirButtons(): void {
  dirBox.replaceChildren();
  for (let d = 0; d < dirCount(); d++) {
    const b = button(dirLabel(d), `small${d === curDir ? ' on' : ''}`, () => {
      curDir = d;
      rebuildDirButtons();
      scheduleStrip();
    });
    dirBox.appendChild(b);
  }
}

const strip = $('strip');
let stripToken = 0;
let stripRaf = 0;
function scheduleStrip(): void {
  cancelAnimationFrame(stripRaf);
  stripRaf = requestAnimationFrame(() => void regenStrip());
}

async function regenStrip(): Promise<void> {
  const token = ++stripToken;
  const n = frameCount();
  const { width: w, height: h2 } = settings;
  let canvases = [...strip.querySelectorAll('canvas')];
  if (canvases.length !== n || canvases.some((c) => c.width !== w || c.height !== h2)) {
    strip.replaceChildren();
    canvases = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h2;
      c.title = `프레임 ${i + 1}`;
      c.addEventListener('click', () => {
        setPlaying(false);
        setFrame(i);
      });
      strip.appendChild(c);
      canvases.push(c);
    }
  }
  setFrame(curFrame);
  for (let i = 0; i < n; i++) {
    if (token !== stripToken) return;
    const px = getFrame(curDir, i);
    canvases[i].getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h2), 0, 0);
    if (i % 6 === 5) await nextFrame();
  }
}

function updateInfo(): void {
  const s = settings, n = frameCount(), dirs = dirCount();
  const sheet = `시트 ${n * s.width * s.exportScale}×${dirs * s.height * s.exportScale}px`;
  const p = isImage() ? imgSrc.prepare(s) : null;
  const from = p ? `원본 셀 ${p.cw}×${p.ch}px (자른 영역 ${p.crop.w}×${p.crop.h}) → ` : '';
  $('pixelInfo').textContent = `${from}${s.width}×${s.height}px · ${dirs}${isImage() ? '행' : '방향'} × ${n}프레임 → ${sheet}`;
}

// ---------------------------------------------------------------------------
// 설정 패널
// ---------------------------------------------------------------------------
const panel = $('panel');
const form = new Form(settings, (key) => onSettingChanged(key));
const clipSelect = h('select');
const clipInfo = h('p', { class: 'hint' });
let frameCountCtl: ReturnType<Form['number']>;
let colorsCtl: ReturnType<Form['slider']>;
let customCtl: ReturnType<Form['textarea']>;
let toonCtl: ReturnType<Form['slider']>;
let sourceCtl: ReturnType<Form['select']>;
let dirCtl: ReturnType<Form['select']>;
let autoFramesCtl: ReturnType<Form['check']>;
let imgInfo: HTMLElement;
let sdInfo: HTMLElement;
const modelSections: HTMLElement[] = [];
const imageSections: HTMLElement[] = [];
let exportBtnEls: HTMLButtonElement[] = [];

function refreshClipSelect(): void {
  clipSelect.replaceChildren(new Option('(정지 포즈)', '-1'));
  stage.clips.forEach((c, i) => {
    const label = c.source && c.source !== stage.modelName && c.source !== c.name ? `${c.name} · ${c.source}` : c.name;
    clipSelect.appendChild(new Option(`${label} (${c.clip.duration.toFixed(2)}s)`, String(i)));
  });
  clipSelect.value = String(stage.activeClip);
  updateClipInfo();
}

function updateClipInfo(): void {
  const c = stage.activeClip >= 0 ? stage.clips[stage.activeClip] : null;
  if (!c) {
    clipInfo.textContent = stage.clips.length ? '' : '이 모델에는 모션이 없습니다. "모션 추가"로 불러오세요.';
    clipInfo.className = 'hint';
    return;
  }
  const bad = c.matched < c.total * 0.5;
  clipInfo.textContent = bad
    ? `⚠ 본 이름이 모델과 거의 맞지 않습니다 (${c.matched}/${c.total} 트랙). 같은 리그의 모션인지 확인하세요.`
    : `길이 ${c.clip.duration.toFixed(2)}초 · 트랙 ${c.matched}/${c.total} 매칭`;
  clipInfo.className = bad ? 'hint warn' : 'hint';
}

function updateAutoFrames(): void {
  if (settings.autoFrames) settings.frameCount = frameCount();
  frameCountCtl.sync();
  (frameCountCtl.row.querySelector('input') as HTMLInputElement).disabled = settings.autoFrames;
}

function updatePaletteUi(): void {
  colorsCtl.row.style.display = settings.paletteMode === 'auto' ? '' : 'none';
  customCtl.row.style.display = settings.paletteMode === 'custom' ? '' : 'none';
  toonCtl.row.style.display = settings.shading === 'toon' ? '' : 'none';
}

function onSettingChanged(key: keyof Settings): void {
  if (key === 'directions') {
    curDir = Math.min(curDir, dirCount() - 1);
    rebuildDirButtons();
  }
  if (key === 'fps' || key === 'autoFrames' || key === 'loop') updateAutoFrames();
  if (key === 'fps' && playing) acc = curFrame / settings.fps;
  if (key === 'paletteMode' || key === 'shading') updatePaletteUi();
  if (key === 'source') {
    onSourceChanged();
    return;
  }
  if (key.startsWith('sd')) updateSdInfo();
  if (isImage()) {
    // 시트 칸 수가 바뀌면 방향/프레임 수가 달라진다
    curDir = Math.min(curDir, dirCount() - 1);
    rebuildDirButtons();
    updateImageInfo();
  }
  setFrame(curFrame);
  updateInfo();
  scheduleStrip();
  saveSoon();
}

/** 미리보기/3D 뷰 상단 컨트롤 */
function buildViewControls(): void {
  const mkSelect = (opts: [string, string][], value: string, onChange: (v: string) => void) => {
    const sel = h('select', { class: 'mini' });
    for (const [v, t] of opts) sel.appendChild(new Option(t, v));
    sel.value = value;
    sel.addEventListener('change', () => onChange(sel.value));
    return sel;
  };
  const applyBg = () => {
    const wrap = $('pixelWrap');
    wrap.className = `bg-${prefs.bg}`;
  };
  $('pixelCtl').append(
    mkSelect([['single', '선택한 방향'], ['all', '전체 방향']], prefs.view, (v) => {
      prefs.view = v as Prefs['view'];
      lastDrawnSize = '';
      saveSoon();
    }),
    mkSelect(BG_LABELS, prefs.bg, (v) => {
      prefs.bg = v as Prefs['bg'];
      applyBg();
      saveSoon();
    }),
  );
  applyBg();
  $('viewCtl').append(
    button('3/4', 'small', () => stage.viewDefault()),
    button('정면', 'small', () => stage.viewSprite(0)),
    button('스프라이트 시점', 'small', () => stage.viewSprite(settings.pitch)),
  );
}

function resetSettings(next: Settings): void {
  Object.assign(settings, next);
  form.syncAll();
  curDir = Math.min(curDir, dirCount() - 1);
  rebuildDirButtons();
  updateAutoFrames();
  updatePaletteUi();
  updateSourceUi();
  updateSdInfo();
  setFrame(0);
  updateInfo();
  scheduleStrip();
  saveSoon();
}

function buildPanel(): void {
  const secSource = form.section(panel, '입력 소스');
  sourceCtl = form.select(secSource, '소스', 'source', [['model', '3D 모델 + 모션'], ['image', 'HD 이미지 → SD 도트']]);
  secSource.appendChild(h('p', { class: 'hint' }, '이미지 모드: HD 일러스트·스프라이트·프레임 시트를 불러와 같은 팔레트/외곽선/내보내기 기능으로 저해상도 도트로 줄입니다.'));

  const secImage = form.section(panel, 'HD 이미지 → SD');
  imageSections.push(secImage.parentElement!);
  imgInfo = h('p', { class: 'hint' }, '이미지가 없습니다.');
  secImage.append(
    button('이미지 열기 (여러 장 · GIF 가능)', 'primary', () => $<HTMLInputElement>('fileImage').click()),
    imgInfo,
  );
  form.number(secImage, '시트 가로 칸', 'imgCols', 1, 64);
  form.number(secImage, '시트 세로 칸', 'imgRows', 1, 64);
  secImage.appendChild(h('p', { class: 'hint' }, '한 장짜리 시트일 때만 적용됩니다. 열 = 프레임, 행 = 방향(스프라이트 시트와 같은 배치). 여러 장/GIF 는 파일 이름 순서의 프레임 한 줄로 취급합니다.'));
  form.select(secImage, '축소 방식', 'imgAlgo', [
    ['box', '영역 평균 (부드러움)'],
    ['mode', '최빈색 (또렷함, 일러스트에 추천)'],
    ['nearest', '최근접 (원본 픽셀 샘플)'],
  ]);
  form.select(secImage, '맞춤', 'imgFit', [['contain', '비율 유지 (전체 보이기)'], ['cover', '비율 유지 (꽉 채우기)'], ['stretch', '늘이기']]);
  form.select(secImage, '정렬', 'imgAlign', [['bottom', '아래 가운데 (캐릭터)'], ['center', '가운데']]);
  form.check(secImage, '투명/배경 여백 자동 자르기', 'imgTrim');
  form.slider(secImage, '여백(px)', 'imgMargin', 0, 16, 1);
  form.check(secImage, '배경색 제거 (좌상단 색, 가장자리 연결 영역)', 'imgBgRemove');
  form.slider(secImage, '허용 오차', 'imgBgTolerance', 0, 100, 1, (v) => `${v}%`);
  form.slider(secImage, '가장자리 정리', 'imgBgEdge', 0, 4, 1, (v) => `${v}px`);
  form.check(secImage, '내부 배경도 제거 (목 틈·팔 사이, 같은 색 전경도 지워질 수 있음)', 'imgBgGlobal');
  secImage.appendChild(
    button('소스 비율에 맞춰 세로 크기 계산', 'small', () => {
      const p = imgSrc.prepare(settings);
      if (!p) return;
      const aw = Math.max(1, settings.width - 2 * settings.imgMargin);
      settings.height = Math.max(8, Math.min(512, Math.round((p.crop.h * aw) / p.crop.w) + 2 * settings.imgMargin));
      form.syncAll();
      onSettingChanged('height');
    }),
  );

  const secModel = form.section(panel, '모델 · 모션');
  modelSections.push(secModel.parentElement!);
  const modelName = h('p', { class: 'hint', id: 'modelName' });
  secModel.append(
    modelName,
    h('label', { class: 'row col' }, h('span', { class: 'lbl' }, '모션(애니메이션 클립)'), clipSelect),
    clipInfo,
  );
  clipSelect.addEventListener('change', () => {
    stage.activeClip = Number(clipSelect.value);
    curFrame = 0;
    updateAutoFrames();
    updateClipInfo();
    setFrame(0);
    updateInfo();
    scheduleStrip();
  });
  form.check(secModel, '제자리 모션 (루트 이동 제거)', 'inPlace');
  form.check(secModel, '루프 모션', 'loop');

  const secSd = form.section(panel, 'SD 비율 (7등신 → 2~3등신)');
  modelSections.push(secSd.parentElement!);
  form.check(secSd, 'SD 비율 적용', 'sdEnabled');
  const sdPresets = h('div', { class: 'btn-row' });
  for (const pr of SD_PRESETS) {
    sdPresets.appendChild(
      button(pr.label, 'small', () => {
        if (pr.p) {
          Object.assign(settings, { sdEnabled: true, sdHead: pr.p.head, sdTorso: pr.p.torso, sdArm: pr.p.arm, sdLeg: pr.p.leg });
        } else {
          settings.sdEnabled = false;
        }
        form.syncAll();
        onSettingChanged('sdEnabled');
      }),
    );
  }
  secSd.appendChild(sdPresets);
  form.slider(secSd, '머리 크기', 'sdHead', 1, 3.5, 0.05, (v) => `×${v.toFixed(2)}`);
  form.slider(secSd, '몸통 크기', 'sdTorso', 0.3, 1.2, 0.01, (v) => `×${v.toFixed(2)}`);
  form.slider(secSd, '팔 크기', 'sdArm', 0.3, 1.2, 0.01, (v) => `×${v.toFixed(2)}`);
  form.slider(secSd, '다리 크기', 'sdLeg', 0.25, 1.2, 0.01, (v) => `×${v.toFixed(2)}`);
  sdInfo = h('p', { class: 'hint' });
  secSd.append(
    sdInfo,
    h('p', { class: 'hint' }, '본 이름으로 머리/몸통/팔/다리를 자동 인식해 부위별로 스케일합니다 (Mixamo, MMD, 일반 리그). 다리가 짧아지면 발이 바닥에 닿도록 자동으로 내립니다. 본이 없는 정적 메시에는 적용되지 않습니다.'),
  );

  const secSprite = form.section(panel, '스프라이트');
  const presets = h('div', { class: 'btn-row' });
  for (const n of [16, 32, 48, 64, 96, 128, 192]) {
    presets.appendChild(
      button(String(n), 'small', () => {
        settings.width = settings.height = n;
        form.syncAll();
        onSettingChanged('width');
      }),
    );
  }
  secSprite.append(h('span', { class: 'hint' }, '해상도 프리셋 (정사각)'), presets);
  form.number(secSprite, '가로(px)', 'width', 8, 512);
  form.number(secSprite, '세로(px)', 'height', 8, 512);
  dirCtl = form.select(secSprite, '방향 수', 'directions', [['1', '1방향'], ['4', '4방향'], ['8', '8방향'], ['16', '16방향']]);
  form.slider(secSprite, 'FPS', 'fps', 1, 60, 1);
  autoFramesCtl = form.check(secSprite, '프레임 수 자동 (길이 × FPS)', 'autoFrames');
  frameCountCtl = form.number(secSprite, '프레임 수', 'frameCount', 1, 240);

  const secCam = form.section(panel, '카메라');
  modelSections.push(secCam.parentElement!);
  form.slider(secCam, '기울기', 'pitch', 0, 80, 1, (v) => `${v}°`);
  form.slider(secCam, '확대', 'zoom', 40, 250, 1, (v) => `${v}%`);
  form.slider(secCam, '가로 이동', 'offsetX', -32, 32, 1, (v) => `${v}px`);
  form.slider(secCam, '세로 이동', 'offsetY', -32, 32, 1, (v) => `${v}px`);
  secCam.appendChild(h('p', { class: 'hint' }, '카메라는 모션 전체 범위에 맞춰 고정되어 프레임 간 크기가 흔들리지 않습니다. 정면(S) 기준으로 방향이 시계 방향으로 돕니다.'));

  const secLight = form.section(panel, '셰이딩 · 조명');
  modelSections.push(secLight.parentElement!);
  form.select(secLight, '셰이딩', 'shading', [['toon', '툰 (단계 음영)'], ['original', '원본 재질']]);
  toonCtl = form.slider(secLight, '음영 단계', 'toonSteps', 2, 6, 1);
  form.slider(secLight, '광원 방향', 'lightAzimuth', -180, 180, 1, (v) => `${v}°`);
  form.slider(secLight, '광원 높이', 'lightElevation', 0, 89, 1, (v) => `${v}°`);
  form.slider(secLight, '광원 세기', 'lightIntensity', 0, 6, 0.1, (v) => v.toFixed(1));
  form.slider(secLight, '환경광', 'ambient', 0, 3, 0.05, (v) => v.toFixed(2));

  const secStyle = form.section(panel, '도트 스타일');
  form.select(secStyle, '팔레트', 'paletteMode', [
    ['auto', '자동 추출'],
    ...Object.entries(PRESETS).map(([k, v]) => [k, v.label] as [string, string]),
    ['custom', '직접 입력'],
    ['none', '제한 없음'],
  ]);
  colorsCtl = form.slider(secStyle, '색상 수', 'colors', 2, 64, 1);
  customCtl = form.textarea(secStyle, '색상 목록 (#rrggbb)', 'customPalette');
  secStyle.append(h('div', { class: 'hint' }, '사용 중인 팔레트: ', h('b', { id: 'palCount' })), h('div', { id: 'swatches' }));
  form.slider(secStyle, '디더링', 'dither', 0, 1, 0.05, (v) => v.toFixed(2));
  form.slider(secStyle, '채도', 'saturation', 0, 2, 0.05, (v) => v.toFixed(2));
  form.slider(secStyle, '대비', 'contrast', 0.5, 1.8, 0.05, (v) => v.toFixed(2));
  form.slider(secStyle, '밝기', 'brightness', -0.5, 0.5, 0.01, (v) => v.toFixed(2));
  form.slider(secStyle, '알파 임계값', 'alphaThreshold', 1, 255, 1);
  form.check(secStyle, '외곽선', 'outline');
  form.color(secStyle, '외곽선 색', 'outlineColor');

  const secExport = form.section(panel, '내보내기');
  form.select(secExport, '출력 배율', 'exportScale', [['1', '×1 (원본 픽셀)'], ['2', '×2'], ['4', '×4'], ['8', '×8']]);
  form.number(secExport, '시트 간격(px)', 'sheetPadding', 0, 16);
  const exportBtns = h('div', { class: 'btn-row' });
  exportBtns.append(
    button('시트 PNG + JSON', 'primary', () => void doExport('sheet')),
    button('GIF (현재 방향)', '', () => void doExport('gif')),
    button('프레임 PNG (zip)', '', () => void doExport('zip')),
    button('현재 프레임 PNG', '', () => void doExport('frame')),
  );
  exportBtnEls = [...exportBtns.querySelectorAll('button')];
  secExport.append(
    exportBtns,
    h('p', { class: 'hint' }, '시트: 행 = 방향, 열 = 프레임. JSON 은 Aseprite/TexturePacker(hash) 호환 형식입니다. 시트 간격은 프레임 둘레의 투명 여백으로, 텍스처 필터링 시 이웃 프레임 색 번짐을 막습니다.'),
  );

  const secPreset = form.section(panel, '설정', false);
  const settingsFile = h('input', { type: 'file', accept: '.json,application/json', hidden: '' });
  settingsFile.addEventListener('change', async () => {
    const f = settingsFile.files?.[0];
    settingsFile.value = '';
    if (!f) return;
    try {
      resetSettings(sanitizeSettings(JSON.parse(await f.text())));
      setStatus(`설정을 불러왔습니다: ${f.name}`);
    } catch {
      setStatus('설정 파일을 읽을 수 없습니다.', 'err');
    }
  });
  const presetBtns = h('div', { class: 'btn-row' });
  presetBtns.append(
    button('기본값으로', '', () => {
      resetSettings({ ...DEFAULTS });
      setStatus('설정을 기본값으로 되돌렸습니다.');
    }),
    button('설정 저장(.json)', '', () => downloadBlob(new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }), 'sprite_settings.json')),
    button('설정 불러오기', '', () => settingsFile.click()),
  );
  secPreset.append(presetBtns, settingsFile, h('p', { class: 'hint' }, '설정은 자동으로 저장되어 다음 실행 때 복원됩니다. 모델/모션은 저장되지 않습니다.'));

  updateAutoFrames();
  updatePaletteUi();
  updateSourceUi();
  updateSdInfo();
}

/** SD 비율 안내: 대략의 등신 수와 인식된 본 개수 */
function updateSdInfo(): void {
  if (!sdInfo) return;
  const c = stage.scanProportionBones();
  const s = settings;
  const heads = s.sdEnabled ? headCount({ head: s.sdHead, torso: s.sdTorso, arm: s.sdArm, leg: s.sdLeg }) : 7;
  const missing = c.head === 0 || c.leg === 0;
  sdInfo.textContent = `${s.sdEnabled ? '현재 약' : '원본 약'} ${heads.toFixed(1)}등신 · 인식된 본: 머리 ${c.head} · 몸통 ${c.torso} · 팔 ${c.arm} · 다리 ${c.leg}` +
    (missing ? ' — ⚠ 머리/다리 본을 찾지 못해 일부가 적용되지 않습니다.' : '');
  sdInfo.className = missing ? 'hint warn' : 'hint';
}

// ---------------------------------------------------------------------------
// 입력 소스(3D / 이미지) 전환
// ---------------------------------------------------------------------------
const srcCanvas = $<HTMLCanvasElement>('srcView');

function updateSourceUi(): void {
  const img = isImage();
  modelSections.forEach((el) => (el.style.display = img ? 'none' : ''));
  imageSections.forEach((el) => (el.style.display = img ? '' : 'none'));
  for (const c of [dirCtl, autoFramesCtl, frameCountCtl]) c.row.style.display = img ? 'none' : '';
  stage.renderer.domElement.style.display = img ? 'none' : '';
  srcCanvas.style.display = img ? 'block' : 'none';
  $('viewLabel').textContent = img ? '원본 (HD)' : '3D 뷰';
  $('viewHint').textContent = img ? '점선 = 자르기 영역 (모든 프레임의 합집합)' : '드래그 회전 · 휠 확대 · 우클릭 이동';
  $('viewCtl').style.display = img ? 'none' : '';
  lastSrcKey = '';
  updateImageInfo();
}

function updateImageInfo(): void {
  if (!imgInfo) return;
  const p = imgSrc.prepare(settings);
  imgInfo.textContent = p
    ? `${imgSrc.name} · 원본 ${imgSrc.images[0].w}×${imgSrc.images[0].h}px${imgSrc.images.length > 1 ? ` ×${imgSrc.images.length}장` : ''} · ${p.cols}×${p.rows}칸 (셀 ${p.cw}×${p.ch}px)`
    : '이미지가 없습니다. "이미지 열기" 또는 파일을 창에 놓으세요.';
}

function onSourceChanged(): void {
  curFrame = 0;
  curDir = Math.min(curDir, dirCount() - 1);
  updateSourceUi();
  rebuildDirButtons();
  updateAutoFrames();
  setFrame(0);
  updateInfo();
  lastDrawnSize = '';
  scheduleStrip();
  saveSoon();
  if (isImage() && !imgSrc.loaded) setStatus('HD 이미지를 불러오세요 (이미지 열기 버튼 또는 파일 드롭).', 'warn');
}

let lastSrcKey = '';
function drawSource(): void {
  const p = imgSrc.prepare(settings);
  const host = $('viewport');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.max(1, Math.floor(host.clientWidth * dpr)), ch = Math.max(1, Math.floor(host.clientHeight * dpr));
  const key = [imgSrc.version, p?.key, curDir, curFrame, cw, ch].join('|');
  if (key === lastSrcKey) return;
  lastSrcKey = key;
  if (srcCanvas.width !== cw || srcCanvas.height !== ch) {
    srcCanvas.width = cw;
    srcCanvas.height = ch;
  }
  const ctx = srcCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, cw, ch);
  const frame = p?.frames[curDir]?.[curFrame];
  if (!p || !frame) return;
  const tmp = document.createElement('canvas');
  tmp.width = p.cw;
  tmp.height = p.ch;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(frame), p.cw, p.ch), 0, 0);
  const sc = Math.min((cw - 24 * dpr) / p.cw, (ch - 24 * dpr) / p.ch);
  const dw = p.cw * sc, dh = p.ch * sc, dx = (cw - dw) / 2, dy = (ch - dh) / 2;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tmp, dx, dy, dw, dh);
  ctx.strokeStyle = '#6ea8ff';
  ctx.lineWidth = 1.5 * dpr;
  ctx.setLineDash([6 * dpr, 4 * dpr]);
  ctx.strokeRect(dx + p.crop.x * sc, dy + p.crop.y * sc, p.crop.w * sc, p.crop.h * sc);
}

async function openImages(files: File[]): Promise<void> {
  setStatus('이미지를 읽는 중…');
  try {
    await imgSrc.load(files);
    if (imgSrc.sliceable) {
      settings.imgCols = 1; // 새 이미지는 한 칸으로 시작 (시트면 칸 수를 지정)
      settings.imgRows = 1;
    }
    settings.source = 'image';
    form.syncAll();
    onSourceChanged();
    setStatus(
      `이미지 불러옴: ${imgSrc.name} (${imgSrc.images.length}장). 시트라면 가로/세로 칸 수를 지정하세요.`,
    );
  } catch (e) {
    console.error(e);
    setStatus(`이미지 불러오기 실패: ${(e as Error).message}`, 'err');
  }
}

// ---------------------------------------------------------------------------
// 불러오기
// ---------------------------------------------------------------------------
function afterModelChange(): void {
  $('modelName').textContent = `모델: ${stage.modelName}`;
  updateSdInfo();
  refreshClipSelect();
  curFrame = 0;
  updateAutoFrames();
  setFrame(0);
  updateInfo();
  scheduleStrip();
}

function loadSample(): void {
  const s = createSampleCharacter();
  stage.setModel(s.object, s.animations, '샘플 캐릭터');
  stage.activeClip = Math.max(0, s.animations.findIndex((a) => a.name === 'Walk'));
  if (isImage()) {
    settings.source = 'model';
    sourceCtl.sync();
    onSourceChanged();
  }
  afterModelChange();
  setStatus('샘플 캐릭터를 불러왔습니다. 모델/모션 파일을 끌어다 놓아 보세요.');
}

async function addMotionFiles(files: File[]): Promise<void> {
  let first = -1;
  for (const f of files) {
    const before = stage.clips.length;
    if (ext(f.name) === 'vmd') {
      if (!stage.mmd) {
        setStatus(`${f.name}: VMD 모션은 PMX/PMD 모델에서만 쓸 수 있습니다.`, 'warn');
        continue;
      }
      const clip = await loadVmd(f, stage.mmd.mesh);
      if (!clip.tracks.length) {
        setStatus(`${f.name}: 이 모델의 본 이름과 맞는 모션 트랙이 없습니다.`, 'warn');
        continue;
      }
      stage.addClips([clip], clip.name);
    } else {
      const L = await loadModelFiles([f]);
      if (!L.animations.length) {
        setStatus(`${f.name}: 모션이 들어 있지 않습니다.`, 'warn');
        continue;
      }
      stage.addClips(L.animations, f.name.replace(/\.[^.]+$/, ''));
    }
    if (first < 0) first = before;
  }
  if (first < 0) return;
  stage.activeClip = first;
  refreshClipSelect();
  curFrame = 0;
  updateAutoFrames();
  setFrame(0);
  updateInfo();
  scheduleStrip();
  const c = stage.clips[first];
  if (c.matched === 0) setStatus(`모션 "${c.name}" 의 본 이름이 현재 모델과 하나도 맞지 않아 움직이지 않습니다.`, 'warn');
  else setStatus(`모션 추가: ${c.name} (트랙 ${c.matched}/${c.total} 매칭)`, c.matched < c.total * 0.5 ? 'warn' : '');
}

async function openFiles(files: File[], asMotion = false): Promise<void> {
  if (!files.length) return;
  setStatus('불러오는 중…');
  try {
    if (asMotion) {
      await addMotionFiles(files);
      return;
    }
    const vmds = files.filter((f) => ext(f.name) === 'vmd');
    const imgs = files.filter((f) => IMAGE_EXT.includes(ext(f.name)));
    if (!files.some((f) => MAIN_EXT.includes(ext(f.name))) && !vmds.length && imgs.length) {
      await openImages(imgs); // 모델 없이 이미지만 → HD→SD 변환 모드
      return;
    }
    if (!files.some((f) => MAIN_EXT.includes(ext(f.name))) && vmds.length) {
      await addMotionFiles(vmds); // VMD 만 선택한 경우: 현재 MMD 모델에 모션으로 추가
      return;
    }
    const L = await loadModelFiles(files);
    if (!L.hasMesh) {
      if (L.animations.length) {
        await addMotionFiles(files.filter((f) => /\.(glb|gltf|fbx)$/i.test(f.name)));
        return;
      }
      throw new Error('메시도 모션도 찾지 못했습니다.');
    }
    stage.setModel(L.object, L.animations, L.name);
    if (isImage()) {
      settings.source = 'model';
      sourceCtl.sync();
      onSourceChanged();
    }
    afterModelChange();
    const hint = L.mmd
      ? ' (MMD: 텍스처가 안 보이면 "폴더 열기"로 모델 폴더째 불러오세요. 모션은 .vmd 를 "모션 추가"로)'
      : '';
    setStatus(
      `불러옴: ${L.name} · 모션 ${L.animations.length}개` +
        (L.animations.length ? '' : hint || ' (모션이 없으면 "모션 추가"로 FBX/GLB 모션을 불러오세요)'),
    );
    if (L.mmd && vmds.length) await addMotionFiles(vmds);
  } catch (e) {
    console.error(e);
    setStatus(`불러오기 실패: ${(e as Error).message}`, 'err');
  }
}

const topActions = $('topActions');
const fileModel = $<HTMLInputElement>('fileModel');
const fileMotion = $<HTMLInputElement>('fileMotion');
const fileFolder = $<HTMLInputElement>('fileFolder');
const fileImage = $<HTMLInputElement>('fileImage');
fileImage.addEventListener('change', () => {
  void openImages([...(fileImage.files ?? [])]);
  fileImage.value = '';
});
topActions.append(
  button('모델 열기', 'primary', () => fileModel.click()),
  button('폴더 열기', '', () => fileFolder.click()),
  button('모션 추가', '', () => fileMotion.click()),
  button('샘플 캐릭터', '', loadSample),
);
fileModel.addEventListener('change', () => {
  void openFiles([...(fileModel.files ?? [])]);
  fileModel.value = '';
});
fileFolder.addEventListener('change', () => {
  void openFiles([...(fileFolder.files ?? [])]);
  fileFolder.value = '';
});
fileMotion.addEventListener('change', () => {
  void openFiles([...(fileMotion.files ?? [])], true);
  fileMotion.value = '';
});

const dropEl = $('drop');
let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropEl.classList.add('show');
});
window.addEventListener('dragover', (e) => hasFiles(e) && e.preventDefault());
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    dropEl.classList.remove('show');
  }
});
/** 드롭된 항목에서 파일을 모은다. 폴더는 재귀적으로 펼친다 (MMD 모델 폴더째 드롭 지원). */
async function filesFromDrop(dt: DataTransfer): Promise<File[]> {
  // 이벤트가 끝나면 dt 가 비워지므로 첫 await 이전에 동기적으로 엔트리를 확보한다.
  const entries = [...dt.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.() ?? null)
    .filter((x): x is FileSystemEntry => x !== null);
  if (!entries.length) return [...dt.files];
  const out: File[] = [];
  const walk = async (en: FileSystemEntry): Promise<void> => {
    if (en.isFile) {
      out.push(await new Promise<File>((res, rej) => (en as FileSystemFileEntry).file(res, rej)));
    } else if (en.isDirectory) {
      const reader = (en as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c);
      }
    }
  };
  for (const en of entries) await walk(en);
  return out;
}

window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('show');
  if (e.dataTransfer) void filesFromDrop(e.dataTransfer).then((files) => openFiles(files));
});

// ---------------------------------------------------------------------------
// 내보내기
// ---------------------------------------------------------------------------
async function gatherFrames(dirs: number[]): Promise<Frames> {
  const n = frameCount();
  const out: Frames = [];
  let k = 0;
  for (const d of dirs) {
    const row: Uint8ClampedArray[] = [];
    for (let i = 0; i < n; i++) {
      row.push(getFrame(d, i));
      if (++k % 12 === 0) await nextFrame();
    }
    out.push(row);
  }
  return out;
}

async function doExport(kind: 'sheet' | 'gif' | 'frame' | 'zip'): Promise<void> {
  const s = settings;
  const clipName = isImage() ? 'sd' : stage.activeClip >= 0 ? stage.clips[stage.activeClip].name : 'pose';
  const base = safeName(`${isImage() ? imgSrc.name : stage.modelName}_${clipName}`);
  const n = frameCount();
  const dirs = dirCount();
  const dirNames = Array.from({ length: dirs }, (_, d) => dirLabel(d));
  const allDirs = Array.from({ length: dirs }, (_, d) => d);
  exportBtnEls.forEach((b) => (b.disabled = true));
  try {
    setStatus('내보내는 중…');
    await nextFrame(); // 상태 문구가 먼저 그려지도록
    if (kind === 'sheet') {
      const frames = await gatherFrames(allDirs);
      const sheet = buildSheet(frames, s.width, s.height, s.exportScale, s.sheetPadding);
      const png = `${base}_sheet.png`;
      downloadBlob(await toBlob(sheet), png);
      const json = buildJson({
        name: base, clip: safeName(clipName), image: png, w: s.width, h: s.height,
        scale: s.exportScale, dirs, count: n, fps: s.fps, pad: s.sheetPadding, dirNames,
      });
      downloadBlob(new Blob([json], { type: 'application/json' }), `${base}_sheet.json`);
      setStatus(`시트 저장: ${png} (${sheet.width}×${sheet.height}px) + JSON`);
    } else if (kind === 'zip') {
      const frames = await gatherFrames(allDirs);
      const zip = await buildZip(frames, s.width, s.height, s.exportScale, base, dirNames);
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${base}_frames.zip`);
      setStatus(`zip 저장: ${base}_frames.zip (${dirs * n}장)`);
    } else if (kind === 'gif') {
      const [row] = await gatherFrames([curDir]);
      const bytes = encodeGif(row, s.width, s.height, s.exportScale, s.fps);
      const name = `${base}_${dirLabel(curDir)}.gif`;
      downloadBlob(new Blob([bytes as BlobPart], { type: 'image/gif' }), name);
      setStatus(`GIF 저장: ${name}`);
    } else {
      const px = getFrame(curDir, curFrame);
      const c = buildSheet([[px]], s.width, s.height, s.exportScale);
      const name = `${base}_${dirLabel(curDir)}_${String(curFrame).padStart(2, '0')}.png`;
      downloadBlob(await toBlob(c), name);
      setStatus(`프레임 저장: ${name}`);
    }
  } catch (e) {
    console.error(e);
    setStatus(`내보내기 실패: ${(e as Error).message}`, 'err');
  } finally {
    exportBtnEls.forEach((b) => (b.disabled = false));
  }
}

// ---------------------------------------------------------------------------
// 키보드, 메인 루프
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
      const f = Math.floor(acc * settings.fps) % n;
      if (f !== curFrame) setFrame(f);
    }
    ensureStage();
    drawPreview();
    if (isImage()) {
      drawSource();
    } else {
      stage.setPose(curDir, settings.directions, frameTime(curFrame));
      stage.renderViewport();
    }
  } catch (e) {
    console.error(e);
    setStatus(`렌더링 오류: ${(e as Error).message}`, 'err');
  }
  requestAnimationFrame(tick);
}

buildPanel();
buildViewControls();
rebuildDirButtons();
loadSample();
requestAnimationFrame(tick);

// 테스트/디버그용 훅
(window as unknown as Record<string, unknown>).__app = { settings, stage, getFrame, frameCount, imgSrc, dirCount };
