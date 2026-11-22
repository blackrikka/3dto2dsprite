import './style.css';
import { Stage } from './stage';
import { DEFAULTS, Settings, dirName } from './types';
import { Form, button, h } from './ui';
import { PRESETS, RGB, medianCut, parsePalette, presetPalette, rgbToHex } from './palette';
import { prepare, processFrame } from './pixelate';
import { MAIN_EXT, ext, loadModelFiles, loadVmd } from './loaders';
import { createSampleCharacter } from './sample';
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
  return [
    stage.modelVersion, stage.activeClip, s.width, s.height, s.directions, frameCount(), s.loop,
    s.pitch, s.zoom, s.offsetX, s.offsetY, s.inPlace, s.shading, s.toonSteps,
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
  stage.configure(settings);
}

function getRaw(d: number, i: number): Uint8ClampedArray {
  const k = `${d}:${i}`;
  let r = rawCache.get(k);
  if (!r) {
    stage.setPose(d, settings.directions, frameTime(i));
    r = stage.renderRaw(settings.width, settings.height);
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
        const dirs = s.directions;
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

const allCols = () => Math.min(4, settings.directions);

function drawPreview(): void {
  const dirs = prefs.view === 'all' ? Array.from({ length: settings.directions }, (_, d) => d) : [curDir];
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
  const cols = allCols(), rows = Math.ceil(settings.directions / cols);
  const d = Math.floor(((e.clientY - r.top) / r.height) * rows) * cols + Math.floor(((e.clientX - r.left) / r.width) * cols);
  if (d >= 0 && d < settings.directions && d !== curDir) {
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
  for (let d = 0; d < settings.directions; d++) {
    const b = button(dirName(d, settings.directions), `small${d === curDir ? ' on' : ''}`, () => {
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
  const s = settings, n = frameCount();
  $('pixelInfo').textContent =
    `${s.width}×${s.height}px · ${s.directions}방향 × ${n}프레임 → 시트 ${n * s.width * s.exportScale}×${s.directions * s.height * s.exportScale}px`;
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
    curDir = Math.min(curDir, settings.directions - 1);
    rebuildDirButtons();
  }
  if (key === 'fps' || key === 'autoFrames' || key === 'loop') updateAutoFrames();
  if (key === 'fps' && playing) acc = curFrame / settings.fps;
  if (key === 'paletteMode' || key === 'shading') updatePaletteUi();
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
  curDir = Math.min(curDir, settings.directions - 1);
  rebuildDirButtons();
  updateAutoFrames();
  updatePaletteUi();
  setFrame(0);
  updateInfo();
  scheduleStrip();
  saveSoon();
}

function buildPanel(): void {
  const secModel = form.section(panel, '모델 · 모션');
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
  form.select(secSprite, '방향 수', 'directions', [['1', '1방향'], ['4', '4방향'], ['8', '8방향'], ['16', '16방향']]);
  form.slider(secSprite, 'FPS', 'fps', 1, 60, 1);
  form.check(secSprite, '프레임 수 자동 (길이 × FPS)', 'autoFrames');
  frameCountCtl = form.number(secSprite, '프레임 수', 'frameCount', 1, 240);

  const secCam = form.section(panel, '카메라');
  form.slider(secCam, '기울기', 'pitch', 0, 80, 1, (v) => `${v}°`);
  form.slider(secCam, '확대', 'zoom', 40, 250, 1, (v) => `${v}%`);
  form.slider(secCam, '가로 이동', 'offsetX', -32, 32, 1, (v) => `${v}px`);
  form.slider(secCam, '세로 이동', 'offsetY', -32, 32, 1, (v) => `${v}px`);
  secCam.appendChild(h('p', { class: 'hint' }, '카메라는 모션 전체 범위에 맞춰 고정되어 프레임 간 크기가 흔들리지 않습니다. 정면(S) 기준으로 방향이 시계 방향으로 돕니다.'));

  const secLight = form.section(panel, '셰이딩 · 조명');
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
}

// ---------------------------------------------------------------------------
// 불러오기
// ---------------------------------------------------------------------------
function afterModelChange(): void {
  $('modelName').textContent = `모델: ${stage.modelName}`;
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
  const clipName = stage.activeClip >= 0 ? stage.clips[stage.activeClip].name : 'pose';
  const base = safeName(`${stage.modelName}_${clipName}`);
  const n = frameCount();
  const allDirs = Array.from({ length: s.directions }, (_, d) => d);
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
        scale: s.exportScale, dirs: s.directions, count: n, fps: s.fps, pad: s.sheetPadding,
      });
      downloadBlob(new Blob([json], { type: 'application/json' }), `${base}_sheet.json`);
      setStatus(`시트 저장: ${png} (${sheet.width}×${sheet.height}px) + JSON`);
    } else if (kind === 'zip') {
      const frames = await gatherFrames(allDirs);
      const zip = await buildZip(frames, s.width, s.height, s.exportScale, base);
      downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `${base}_frames.zip`);
      setStatus(`zip 저장: ${base}_frames.zip (${s.directions * n}장)`);
    } else if (kind === 'gif') {
      const [row] = await gatherFrames([curDir]);
      const bytes = encodeGif(row, s.width, s.height, s.exportScale, s.fps);
      const name = `${base}_${dirName(curDir, s.directions)}.gif`;
      downloadBlob(new Blob([bytes as BlobPart], { type: 'image/gif' }), name);
      setStatus(`GIF 저장: ${name}`);
    } else {
      const px = getFrame(curDir, curFrame);
      const c = buildSheet([[px]], s.width, s.height, s.exportScale);
      const name = `${base}_${dirName(curDir, s.directions)}_${String(curFrame).padStart(2, '0')}.png`;
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
    stage.setPose(curDir, settings.directions, frameTime(curFrame));
    stage.renderViewport();
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
(window as unknown as Record<string, unknown>).__app = { settings, stage, getFrame, frameCount };
