import * as THREE from 'three';
import { autoMap } from './bones';
import { download, exportGlb, loadMapping, saveMapping } from './io';
import { disposeRig, ext, loadModelFiles, loadVmdData, toRig } from './loaders';
import { buildMmdRig, vmdToClip } from './mmdSkeleton';
import { bake, prepare } from './retarget';
import {
  $, bindDrop, buildLeft, buildPlaybar, buildRight, fillClipSelect, readOptions, renderMapping,
  setHipsPlaceholder, setInfo, setStatus, writeOptions,
} from './ui';
import { Viewer } from './viewer';
import type { MapRow, Rig, RetargetOptions } from './types';
import './style.css';

// ---------- 상태 ----------
let model: Rig | null = null;
let motion: Rig | null = null;
let clipIndex = 0;
let rows: MapRow[] = [];
let opt: RetargetOptions = { fps: 30, inPlace: false, restFix: true, yawDeg: 0, hipsScale: null };
let result: THREE.AnimationClip | null = null;
let rebakeTimer = 0;

// ---------- UI 구성 ----------
buildLeft($('left'));
buildPlaybar($('playbar'));
buildRight($('right'));
opt = readOptions();
const viewer = new Viewer($<HTMLCanvasElement>('view'));

const btnPlay = $<HTMLButtonElement>('btnPlay');
const scrub = $<HTMLInputElement>('scrub');
const timeLbl = $('timeLbl');
const btnSave = $<HTMLButtonElement>('btnSaveMap');
const btnExport = $<HTMLButtonElement>('btnExport');
const selClip = $<HTMLSelectElement>('selClip');

// ---------- 흐름 ----------
function currentSrcClip(): THREE.AnimationClip | null {
  return motion?.clips[clipIndex] ?? null;
}

function refreshInfo() {
  setInfo('infoModel', model ? `${model.name} · 본 ${model.bones.length}개${model.hasMesh ? '' : ' · 메시 없음'}` : '모델 없음');
  const m = motion;
  setInfo('infoMotion', m ? `${m.name} · 본 ${m.bones.length}개 · 클립 ${m.clips.length}개` : '모션 없음');
  fillClipSelect(motion?.clips.map((c) => c.name) ?? [], clipIndex);
}

function updateButtons() {
  const ok = !!result && !!model && !!motion;
  btnSave.disabled = !ok;
  btnExport.disabled = !ok;
}

function renderRows() {
  renderMapping(rows, motion, model, {
    onChange(i, patch) {
      rows[i] = { ...rows[i], ...patch };
      renderRows();
      scheduleRebake();
    },
  });
}

/** 둘 다 있으면 자동 매핑, 아니면 표를 비운다 */
function rebuildRows(keepCustom = false) {
  const custom = keepCustom ? rows.filter((r) => r.custom) : [];
  rows = model && motion ? [...autoMap(motion, model), ...custom] : [];
  renderRows();
}

function scheduleRebake() {
  clearTimeout(rebakeTimer);
  rebakeTimer = window.setTimeout(rebake, 200);
}

function rebake() {
  rebakeTimer = 0;
  opt = readOptions();
  const srcClip = currentSrcClip();
  result = null;
  if (model && motion && srcClip && rows.some((r) => r.enabled && r.source && r.target)) {
    try {
      const prep = prepare(motion, model, rows, opt);
      setHipsPlaceholder(prep.autoRatio);
      result = bake(motion, srcClip, model, prep, opt);
    } catch (e) {
      console.error(e);
      setStatus(`리타깃 실패: ${(e as Error).message}`, 'error');
    }
  } else if (model && motion && srcClip) {
    setStatus('대응되는 본이 없습니다 — 오른쪽 표에서 직접 지정하세요', 'warn');
  }
  // 결과가 없으면 소스만 재생한다. 타깃은 레스트.
  viewer.playClip(result, srcClip);
  updateButtons();
  updateTimeUI();
}

function updateTimeUI() {
  const dur = viewer.duration;
  scrub.max = String(dur);
  scrub.step = String(opt.fps > 0 ? 1 / opt.fps : 0.001);
  if (document.activeElement !== scrub) scrub.value = String(viewer.time);
  timeLbl.textContent = `${viewer.time.toFixed(2)} / ${dur.toFixed(2)}s`;
  btnPlay.textContent = viewer.playing ? '⏸' : '▶';
  btnPlay.disabled = dur <= 0;
}

async function loadModel(files: File[]) {
  try {
    setStatus('모델 불러오는 중…');
    const loaded = await loadModelFiles(files, (m) => setStatus(m, 'warn'));
    const rig = toRig(loaded, 'model');
    const old = model;
    model = rig;
    viewer.setTarget(rig);
    if (old) disposeRig(old);
    rebuildRows();
    refreshInfo();
    warnLoaded(loaded.missing, loaded.unsupported);
    setStatus(`모델 불러옴: ${rig.name}`);
    scheduleRebake();
  } catch (e) {
    setStatus((e as Error).message, 'error');
  }
}

function warnLoaded(missing: string[], unsupported: string[]) {
  const parts: string[] = [];
  if (missing.length) parts.push(`누락된 텍스처: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' …' : ''}`);
  if (unsupported.length) parts.push(`지원하지 않는 형식: ${unsupported.slice(0, 3).join(', ')}`);
  if (parts.length) setStatus(parts.join(' / '), 'warn');
}

async function loadMotion(files: File[]) {
  try {
    setStatus('모션 불러오는 중…');
    const vmdFile = files.find((f) => ext(f.name) === 'vmd');
    let rig: Rig;
    if (vmdFile) {
      const name = vmdFile.name.replace(/\.[^.]+$/, '');
      const vmd = await loadVmdData(vmdFile);
      rig = buildMmdRig(name);
      const { clip, skippedIk } = vmdToClip(vmd, rig);
      clip.name = name;
      rig.clips = [clip];
      if (skippedIk) setStatus('VMD 의 IK(足ＩＫ 등) 모션은 지원하지 않습니다 — 다리가 기본 자세로 남을 수 있습니다', 'warn');
    } else {
      const loaded = await loadModelFiles(files, (m) => setStatus(m, 'warn'));
      rig = toRig(loaded, 'motion');
      warnLoaded(loaded.missing, loaded.unsupported);
      if (rig.clips.length === 0) {
        disposeRig(rig);
        throw new Error('모션 파일에 애니메이션이 없습니다');
      }
    }
    const old = motion;
    motion = rig;
    clipIndex = 0;
    viewer.setSource(rig);
    if (old) disposeRig(old);
    rebuildRows();
    refreshInfo();
    setStatus(`모션 불러옴: ${rig.name} (클립 ${rig.clips.length}개)`);
    scheduleRebake();
  } catch (e) {
    setStatus((e as Error).message, 'error');
  }
}

/** 캔버스에 놓은 파일: .vmd 포함 → 모션, 모델 없음 → 모델, 그 외 → 모션 */
function routeDrop(files: File[]) {
  const hasVmd = files.some((f) => ext(f.name) === 'vmd');
  if (!model && !hasVmd) return loadModel(files);
  return loadMotion(files);
}

// ---------- 이벤트 ----------
bindDrop($('dropModel'), $<HTMLInputElement>('fileModel'), loadModel);
bindDrop($('dropMotion'), $<HTMLInputElement>('fileMotion'), loadMotion);
bindDrop($('view').parentElement!, null, routeDrop);
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

selClip.addEventListener('change', () => {
  clipIndex = Number(selClip.value) || 0;
  scheduleRebake();
});

$('optInPlace').addEventListener('change', scheduleRebake);
$('optRestFix').addEventListener('change', scheduleRebake);
$('optYaw').addEventListener('change', scheduleRebake);
$('optHips').addEventListener('input', scheduleRebake);
$('optFps').addEventListener('input', scheduleRebake);

$('btnAuto').addEventListener('click', () => rebuildRows(true));
$('btnAddRow').addEventListener('click', () => {
  let n = 1;
  while (rows.some((r) => r.key === `custom${n}`)) n++;
  rows.push({ key: `custom${n}`, label: '사용자 지정', source: null, target: null, enabled: false, confidence: 1, custom: true, manual: true });
  renderRows();
});

btnPlay.addEventListener('click', () => {
  if (!viewer.playing && viewer.duration > 0 && viewer.time >= viewer.duration - 1e-6) viewer.setTime(0);
  viewer.playing = !viewer.playing;
  updateTimeUI();
});
scrub.addEventListener('input', () => {
  viewer.playing = false;
  viewer.setTime(Number(scrub.value));
  updateTimeUI();
});
$<HTMLSelectElement>('selSpeed').addEventListener('change', (e) => {
  viewer.speed = Number((e.target as HTMLSelectElement).value) || 1;
});
$<HTMLInputElement>('optLoop').addEventListener('change', (e) => (viewer.loop = (e.target as HTMLInputElement).checked));
$<HTMLInputElement>('optShowSource').addEventListener('change', (e) => (viewer.showSource = (e.target as HTMLInputElement).checked));
$<HTMLInputElement>('optShowSkeleton').addEventListener('change', (e) => (viewer.showSkeleton = (e.target as HTMLInputElement).checked));

viewer.onTick = () => updateTimeUI();

btnExport.addEventListener('click', async () => {
  const srcClip = currentSrcClip();
  if (!result || !model || !motion || !srcClip) return;
  try {
    setStatus('GLB 내보내는 중…');
    const blob = await exportGlb(model, result, viewer);
    download(blob, `${model.name}_${srcClip.name}.glb`);
    setStatus('내보내기 완료');
  } catch (e) {
    console.error(e);
    setStatus(`내보내기 실패: ${(e as Error).message}`, 'error');
  }
});

btnSave.addEventListener('click', () => {
  if (!result || !model || !motion) return;
  download(saveMapping(rows, opt, motion, model), `${model.name}_mapping.json`);
  setStatus('매핑을 저장했습니다');
});

$('btnLoadMap').addEventListener('click', () => $<HTMLInputElement>('fileMapLoad').click());
$<HTMLInputElement>('fileMapLoad').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!model || !motion) return setStatus('모델과 모션을 먼저 불러오세요', 'error');
  try {
    const { rows: loadedRows, opt: loadedOpt, missing } = await loadMapping(file, motion, model);
    rows = loadedRows;
    opt = loadedOpt;
    writeOptions(opt);
    renderRows();
    if (missing.length) setStatus(`매핑 파일의 본 ${missing.length}개를 찾지 못했습니다: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`, 'warn');
    else setStatus('매핑을 불러왔습니다');
    rebake();
  } catch (err) {
    setStatus((err as Error).message, 'error');
  }
});

// ---------- 초기 상태 ----------
renderRows();
updateButtons();
updateTimeUI();
