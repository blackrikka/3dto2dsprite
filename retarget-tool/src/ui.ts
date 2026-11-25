import type * as THREE from 'three';
import { CANON_KEYS, matchedCount } from './bones';
import type { MapRow, Rig, RetargetOptions } from './types';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

let statusTimer = 0;
/** 상태 메시지. info 는 5초 뒤 지운다. */
export function setStatus(msg: string, kind: 'info' | 'warn' | 'error' = 'info') {
  const el = $('status');
  el.textContent = msg;
  el.className = kind === 'error' ? 'err' : kind === 'warn' ? 'warn' : '';
  clearTimeout(statusTimer);
  if (kind === 'info') {
    statusTimer = window.setTimeout(() => {
      if (el.textContent === msg) el.textContent = '';
    }, 5000);
  }
}

/** 왼쪽 패널: 모델/모션 드롭존, 클립, 옵션 */
export function buildLeft(el: HTMLElement) {
  el.innerHTML = `
    <section class="card">
      <h2>① 모델 (타깃)</h2>
      <div class="drop" id="dropModel" tabindex="0">모델 파일을 놓거나 클릭 (.glb .gltf .fbx .pmx .pmd)</div>
      <div class="info" id="infoModel">모델 없음</div>
    </section>
    <section class="card">
      <h2>② 모션 (소스)</h2>
      <div class="drop" id="dropMotion" tabindex="0">모션 파일을 놓거나 클릭 (.glb .gltf .fbx .vmd)</div>
      <div class="info" id="infoMotion">모션 없음</div>
      <label class="field">클립
        <select id="selClip"></select>
      </label>
    </section>
    <section class="card">
      <h2>③ 옵션</h2>
      <label class="chk"><input type="checkbox" id="optInPlace" /> 제자리 (in-place)</label>
      <label class="chk"><input type="checkbox" id="optRestFix" checked /> 레스트 포즈 방향 보정</label>
      <label class="field">소스 방향 회전
        <select id="optYaw">
          <option value="0">0°</option>
          <option value="90">90°</option>
          <option value="180">180°</option>
          <option value="270">270°</option>
        </select>
      </label>
      <label class="field">엉덩이 이동 배율
        <input type="number" id="optHips" step="0.01" min="0" placeholder="자동" />
      </label>
      <label class="field">샘플 FPS
        <input type="number" id="optFps" value="30" min="1" max="120" step="1" />
      </label>
    </section>`;
}

/** 하단 재생바 */
export function buildPlaybar(el: HTMLElement) {
  el.innerHTML = `
    <button id="btnPlay" class="icon" title="재생/일시정지">▶</button>
    <input type="range" id="scrub" min="0" max="0" step="0.001" value="0" />
    <span id="timeLbl" class="time">0.00 / 0.00s</span>
    <label class="field inline">속도
      <select id="selSpeed">
        <option value="0.25">0.25×</option>
        <option value="0.5">0.5×</option>
        <option value="1" selected>1×</option>
        <option value="1.5">1.5×</option>
        <option value="2">2×</option>
      </select>
    </label>
    <label class="chk inline"><input type="checkbox" id="optLoop" checked /> 반복</label>
    <label class="chk inline"><input type="checkbox" id="optShowSource" checked /> 소스 표시</label>
    <label class="chk inline"><input type="checkbox" id="optShowSkeleton" checked /> 소스 뼈대</label>`;
}

/** 오른쪽 패널: 매핑 표 */
export function buildRight(el: HTMLElement) {
  el.innerHTML = `
    <div class="card-head">
      <h2 id="mapTitle">본 매핑</h2>
      <span class="grow"></span>
      <button id="btnAuto" class="small">자동 매핑 다시</button>
      <button id="btnAddRow" class="small">+ 행 추가</button>
    </div>
    <div class="maphead"><span></span><span>라벨</span><span>소스 (모션)</span><span>타깃 (모델)</span><span>신뢰도</span></div>
    <div id="mapTable"></div>`;
}

export function setMapTitle(rows: MapRow[]) {
  $('mapTitle').textContent = `본 매핑 — 매칭 ${matchedCount(rows)}/${CANON_KEYS.length}`;
}

export function setInfo(id: string, text: string) {
  $(id).textContent = text;
}

export function fillClipSelect(names: string[], index: number) {
  const sel = $<HTMLSelectElement>('selClip');
  sel.innerHTML = '';
  if (names.length === 0) {
    sel.add(new Option('(클립 없음)', ''));
    sel.disabled = true;
    return;
  }
  names.forEach((n, i) => sel.add(new Option(n || `클립 ${i + 1}`, String(i))));
  sel.disabled = names.length <= 1;
  sel.value = String(index);
}

export function readOptions(): RetargetOptions {
  const fps = Number($<HTMLInputElement>('optFps').value);
  const hipsRaw = $<HTMLInputElement>('optHips').value.trim();
  const hips = hipsRaw === '' ? NaN : Number(hipsRaw);
  const yaw = Number($<HTMLSelectElement>('optYaw').value);
  return {
    fps: Number.isFinite(fps) && fps >= 1 ? Math.min(120, fps) : 30,
    inPlace: $<HTMLInputElement>('optInPlace').checked,
    restFix: $<HTMLInputElement>('optRestFix').checked,
    yawDeg: ([0, 90, 180, 270].includes(yaw) ? yaw : 0) as 0 | 90 | 180 | 270,
    hipsScale: Number.isFinite(hips) ? hips : null,
  };
}

export function writeOptions(opt: RetargetOptions) {
  $<HTMLInputElement>('optFps').value = String(opt.fps);
  $<HTMLInputElement>('optInPlace').checked = opt.inPlace;
  $<HTMLInputElement>('optRestFix').checked = opt.restFix;
  $<HTMLSelectElement>('optYaw').value = String(opt.yawDeg);
  $<HTMLInputElement>('optHips').value = opt.hipsScale == null ? '' : String(opt.hipsScale);
}

export function setHipsPlaceholder(ratio: number | null) {
  $<HTMLInputElement>('optHips').placeholder = ratio == null ? '자동' : `자동 (${ratio.toFixed(3)})`;
}

/** 드롭존: 드래그 앤 드롭 + 클릭(숨김 input 트리거) */
export function bindDrop(zone: HTMLElement, input: HTMLInputElement | null, onFiles: (files: File[]) => void) {
  zone.addEventListener('click', () => input?.click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input?.click();
    }
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) onFiles(files);
  });
  input?.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length) onFiles(files);
  });
}

interface RowHandlers {
  onChange(index: number, patch: Partial<MapRow>): void;
}

function depthIn(b: THREE.Object3D): number {
  let d = 0;
  for (let p = b.parent; p; p = p.parent) d++;
  return d;
}

/** 본 select 옵션: (없음) + 트리 순서 본 이름 (깊이만큼 들여쓰기) */
function boneOptions(sel: HTMLSelectElement, rig: Rig | null, current: string | null) {
  sel.add(new Option('(없음)', ''));
  if (rig) {
    for (const b of rig.bones) {
      const d = depthIn(b);
      sel.add(new Option(`${'  '.repeat(d)}${b.name}`, b.name));
    }
  }
  sel.value = current && rig?.byName.has(current) ? current : '';
}

function badge(row: MapRow): { text: string; cls: string } {
  if (!row.source || !row.target) return { text: '미매핑', cls: 'bad' };
  if (row.manual) return { text: '수동', cls: 'manual' };
  if (row.confidence >= 0.9) return { text: '높음', cls: 'good' };
  if (row.confidence >= 0.6) return { text: '보통', cls: 'warn' };
  return { text: '낮음', cls: 'bad' };
}

/** 매핑 표 렌더링. 변경은 handlers.onChange 로 알린다. */
export function renderMapping(rows: MapRow[], src: Rig | null, tgt: Rig | null, h: RowHandlers) {
  setMapTitle(rows);
  const box = $('mapTable');
  box.innerHTML = '';
  if (rows.length === 0) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '모델과 모션을 모두 불러오면 자동으로 대응됩니다.';
    box.appendChild(p);
    return;
  }
  rows.forEach((row, i) => {
    const line = document.createElement('div');
    line.className = 'mrow' + (!row.source || !row.target ? ' unmapped' : '');

    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.checked = row.enabled;
    chk.title = '사용';
    chk.addEventListener('change', () => h.onChange(i, { enabled: chk.checked }));

    const lbl = document.createElement('span');
    lbl.className = 'lbl';
    lbl.textContent = row.label;
    lbl.title = row.key;

    const s = document.createElement('select');
    boneOptions(s, src, row.source);
    s.addEventListener('change', () => {
      const v = s.value || null;
      h.onChange(i, { source: v, manual: true, confidence: 1, enabled: !!v && !!row.target });
    });

    const t = document.createElement('select');
    boneOptions(t, tgt, row.target);
    t.addEventListener('change', () => {
      const v = t.value || null;
      h.onChange(i, { target: v, manual: true, confidence: 1, enabled: !!v && !!row.source });
    });

    const b = badge(row);
    const bd = document.createElement('span');
    bd.className = `badge ${b.cls}`;
    bd.textContent = b.text;

    line.append(chk, lbl, s, t, bd);
    box.appendChild(line);
  });
}
