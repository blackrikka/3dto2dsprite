import type * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { CANON_KEYS, labelOf } from './bones';
import type { MapRow, MappingFile, Rig, RetargetOptions } from './types';
import type { Viewer } from './viewer';

/** 결과 클립을 타깃 모델과 함께 GLB 로 내보낸다. (타깃 레스트 상태에서 직렬화) */
export async function exportGlb(tgt: Rig, clip: THREE.AnimationClip, viewer: Viewer): Promise<Blob> {
  const buf = await viewer.exclusive(
    () =>
      new GLTFExporter().parseAsync(tgt.root, {
        binary: true,
        animations: [clip],
        onlyVisible: true,
      }) as Promise<ArrayBuffer>,
  );
  return new Blob([buf], { type: 'model/gltf-binary' });
}

export function saveMapping(rows: MapRow[], opt: RetargetOptions, src: Rig, tgt: Rig): Blob {
  const data: MappingFile = {
    version: 1,
    source: src.name,
    target: tgt.name,
    rows: rows.map((r) => ({ key: r.key, source: r.source, target: r.target, enabled: r.enabled })),
    options: opt,
  };
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

const DEFAULT_OPTS: RetargetOptions = { fps: 30, inPlace: false, restFix: true, yawDeg: 0, hipsScale: null };

function normalizeOptions(o: Partial<RetargetOptions> | undefined): RetargetOptions {
  const fps = Number(o?.fps);
  const yaw = Number(o?.yawDeg);
  const hips = o?.hipsScale == null ? NaN : Number(o.hipsScale);
  return {
    fps: Number.isFinite(fps) && fps >= 1 ? Math.min(120, fps) : DEFAULT_OPTS.fps,
    inPlace: o?.inPlace ?? DEFAULT_OPTS.inPlace,
    restFix: o?.restFix ?? DEFAULT_OPTS.restFix,
    yawDeg: ([0, 90, 180, 270].includes(yaw) ? yaw : 0) as 0 | 90 | 180 | 270,
    hipsScale: Number.isFinite(hips) ? hips : null,
  };
}

/** 매핑 JSON 을 현재 Rig 에 맞춰 읽는다. 없는 본은 null 처리하고 missing 에 모은다. */
export async function loadMapping(
  file: File,
  src: Rig,
  tgt: Rig,
): Promise<{ rows: MapRow[]; opt: RetargetOptions; missing: string[] }> {
  let data: MappingFile;
  try {
    data = JSON.parse(await file.text()) as MappingFile;
  } catch {
    throw new Error('매핑 파일을 읽을 수 없습니다 (JSON 형식이 아닙니다)');
  }
  if (!data || data.version !== 1 || !Array.isArray(data.rows)) {
    throw new Error('지원하지 않는 매핑 파일입니다 (version 1 이 아님)');
  }
  const missing: string[] = [];
  const pick = (name: string | null, rig: Rig) => {
    if (!name) return null;
    if (rig.byName.has(name)) return name;
    missing.push(name);
    return null;
  };
  const rows: MapRow[] = data.rows.map((r) => {
    const source = pick(r.source, src);
    const target = pick(r.target, tgt);
    const canon = CANON_KEYS.includes(r.key);
    return {
      key: r.key,
      label: canon ? labelOf(r.key) : '사용자 지정',
      source,
      target,
      enabled: !!r.enabled && !!source && !!target,
      confidence: 1,
      custom: !canon,
      manual: true,
    };
  });
  return { rows, opt: normalizeOptions(data.options), missing };
}

/** Blob 을 파일로 내려받는다 */
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
