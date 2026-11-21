import './style.css';
import { Stage } from './stage';
import { DEFAULTS, Settings, dirName } from './types';
import { Form, button, h } from './ui';
import { PRESETS, RGB, medianCut, parsePalette, presetPalette, rgbToHex } from './palette';
import { prepare, processFrame } from './pixelate';
import { loadModelFiles } from './loaders';
import { createSampleCharacter } from './sample';
import { Frames, buildJson, buildSheet, downloadBlob, encodeGif, safeName, toBlob } from './exporter';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

const settings: Settings = { ...DEFAULTS };
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
let lastDrawn: Uint8ClampedArray | null = null;
let lastDrawnSize = '';

function drawPreview(): void {
  const px = getFrame(curDir, curFrame);
  const size = `${settings.width}x${settings.height}`;
  if (px === lastDrawn && size === lastDrawnSize) return;
  if (pixelCanvas.width !== settings.width || pixelCanvas.height !== settings.height) {
    pixelCanvas.width = settings.width;
    pixelCanvas.height = settings.height;
    fitPixelCanvas();
  }
  pixelCtx.putImageData(new ImageData(new Uint8ClampedArray(px), settings.width, settings.height), 0, 0);
  lastDrawn = px;
  lastDrawnSize = size;
}

function fitPixelCanvas(): void {
  const wrap = $('pixelWrap');
  const scale = Math.max(1, Math.floor(Math.min((wrap.clientWidth - 16) / settings.width, (wrap.clientHeight - 16) / settings.height)));
  pixelCanvas.style.width = `${settings.width * scale}px`;
  pixelCanvas.style.height = `${settings.height * scale}px`;
}
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

function refreshClipSelect(): void {
  clipSelect.replaceChildren(new Option('(정지 포즈)', '-1'));
  stage.clips.forEach((c, i) => {
    const label = c.source && c.source !== stage.modelName ? `${c.name} · ${c.source}` : c.name;
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
  const exportBtns = h('div', { class: 'btn-row' });
  const bSheet = button('시트 PNG + JSON', 'primary', () => void doExport('sheet'));
  const bGif = button('GIF (현재 방향)', '', () => void doExport('gif'));
  const bFrame = button('현재 프레임 PNG', '', () => void doExport('frame'));
  exportBtns.append(bSheet, bGif, bFrame);
  secExport.append(
    exportBtns,
    h('p', { class: 'hint' }, '시트: 행 = 방향, 열 = 프레임. JSON 은 Aseprite/TexturePacker(hash) 호환 형식입니다.'),
  );

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
    const L = await loadModelFiles([f]);
    if (!L.animations.length) {
      setStatus(`${f.name}: 모션이 들어 있지 않습니다.`, 'warn');
      continue;
    }
    const before = stage.clips.length;
    stage.addClips(L.animations, f.name.replace(/\.[^.]+$/, ''));
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
    setStatus(
      `불러옴: ${L.name} · 모션 ${L.animations.length}개` +
        (L.animations.length ? '' : ' (모션이 없으면 "모션 추가"로 FBX/GLB 모션을 불러오세요)'),
    );
  } catch (e) {
    console.error(e);
    setStatus(`불러오기 실패: ${(e as Error).message}`, 'err');
  }
}

const topActions = $('topActions');
const fileModel = $<HTMLInputElement>('fileModel');
const fileMotion = $<HTMLInputElement>('fileMotion');
topActions.append(
  button('모델 열기', 'primary', () => fileModel.click()),
  button('모션 추가', '', () => fileMotion.click()),
  button('샘플 캐릭터', '', loadSample),
);
fileModel.addEventListener('change', () => {
  void openFiles([...(fileModel.files ?? [])]);
  fileModel.value = '';
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
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropEl.classList.remove('show');
  void openFiles([...(e.dataTransfer?.files ?? [])]);
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

async function doExport(kind: 'sheet' | 'gif' | 'frame'): Promise<void> {
  const s = settings;
  const clipName = stage.activeClip >= 0 ? stage.clips[stage.activeClip].name : 'pose';
  const base = safeName(`${stage.modelName}_${clipName}`);
  const n = frameCount();
  try {
    setStatus('내보내는 중…');
    if (kind === 'sheet') {
      const all = Array.from({ length: s.directions }, (_, d) => d);
      const frames = await gatherFrames(all);
      const sheet = buildSheet(frames, s.width, s.height, s.exportScale);
      const png = `${base}_sheet.png`;
      downloadBlob(await toBlob(sheet), png);
      const json = buildJson({
        name: base, clip: safeName(clipName), image: png, w: s.width, h: s.height,
        scale: s.exportScale, dirs: s.directions, count: n, fps: s.fps,
      });
      downloadBlob(new Blob([json], { type: 'application/json' }), `${base}_sheet.json`);
      setStatus(`시트 저장: ${png} (${sheet.width}×${sheet.height}px) + JSON`);
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
rebuildDirButtons();
loadSample();
requestAnimationFrame(tick);

// 테스트/디버그용 훅
(window as unknown as Record<string, unknown>).__app = { settings, stage, getFrame, frameCount };
