import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { MMDLoader } from 'three-stdlib';
import type { Rig, RigKind, VmdMotion } from './types';

export interface Loaded {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  name: string;
  hasMesh: boolean;
  /** PMX/PMD 모델 여부 */
  mmd: boolean;
  /** 모델이 참조하지만 함께 선택되지 않아 찾지 못한 텍스처 파일명 */
  missing: string[];
  /** 브라우저가 읽을 수 없는 형식(.psd .tif .dds …)의 파일명 */
  unsupported: string[];
}

const IMG_RE = /\.(png|jpe?g|jfif|bmp|tga|tiff?|webp|gif|dds|psd|exr|hdr|ktx2?)$/i;
/** 브라우저(<img>)나 등록된 로더가 읽지 못하는 형식 */
const UNSUPPORTED_RE = /\.(psd|tiff?|dds|exr|hdr|ktx2?)$/i;

export const MAIN_EXT = ['glb', 'gltf', 'fbx', 'pmx', 'pmd'];
export const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';
const baseName = (n: string) => n.split(/[\\/]/).pop() ?? n;
const base = (n: string) => {
  const b = baseName(n);
  try {
    return decodeURIComponent(b).toLowerCase();
  } catch {
    return b.toLowerCase();
  }
};

/** MMD 메시를 트랙 이름으로 가리키기 위한 ASCII 이름 */
export const MMD_MESH_NAME = 'MMDMesh';

interface MeshBuilderLike {
  build(data: object, resourcePath: string, onProgress?: unknown, onError?: (e: unknown) => void): THREE.SkinnedMesh;
}

/**
 * 선택/드롭한 파일들 중 메인 파일(glb/gltf/fbx/pmx/pmd)을 읽는다.
 * .gltf 의 .bin, PMX 의 텍스처처럼 함께 선택된 부속 파일은 파일 이름으로 연결한다.
 */
export async function loadModelFiles(
  files: File[],
  onWarn?: (msg: string) => void,
  onTexturesLoaded?: () => void,
): Promise<Loaded> {
  const main = files.find((f) => MAIN_EXT.includes(ext(f.name)));
  if (!main) throw new Error('지원하는 파일(.glb .gltf .fbx .pmx .pmd)이 없습니다.');

  const urls = new Map<string, string>();
  const urlToName = new Map<string, string>();
  const created: string[] = [];
  for (const f of files) {
    const u = URL.createObjectURL(f);
    created.push(u);
    urls.set(base(f.name), u);
    urlToName.set(u, f.name);
  }
  const missing = new Set<string>();
  const failed = new Set<string>();
  let warnTimer = 0;
  const manager = new THREE.LoadingManager();
  // .tga 텍스처는 브라우저가 못 읽으므로 전용 로더를 등록한다
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const clean = url.split('?')[0];
    const hit = urls.get(base(clean));
    if (hit) return hit;
    // 선택되지 않은 텍스처
    let n = baseName(clean);
    try {
      n = decodeURIComponent(n);
    } catch {
      /* 그대로 */
    }
    if (IMG_RE.test(n)) missing.add(n);
    return url;
  });
  let loadTimer = 0;
  manager.onLoad = () => {
    clearTimeout(loadTimer);
    loadTimer = window.setTimeout(() => onTexturesLoaded?.(), 50);
  };
  manager.onError = (url) => {
    const n = urlToName.get(url);
    if (!n || !IMG_RE.test(n)) return;
    failed.add(n);
    clearTimeout(warnTimer);
    warnTimer = window.setTimeout(() => {
      onWarn?.(`텍스처를 읽지 못했습니다: ${[...failed].slice(0, 4).join(', ')}${failed.size > 4 ? ' …' : ''} (손상되었거나 지원하지 않는 형식)`);
    }, 800);
  };

  try {
    const url = urls.get(base(main.name))!;
    const e = ext(main.name);
    let object: THREE.Object3D;
    let animations: THREE.AnimationClip[] = [];
    let mmd = false;
    if (e === 'pmx' || e === 'pmd') {
      const loader = new MMDLoader(manager);
      const data = await new Promise<object>((res, rej) =>
        (e === 'pmx' ? loader.loadPMX : loader.loadPMD).call(loader, url, res, undefined, rej),
      );
      const builder = (loader as unknown as { meshBuilder: MeshBuilderLike }).meshBuilder;
      object = builder.build(data, '', undefined, (err) => console.warn('MMD 텍스처/재질 경고', err));
      object.name = MMD_MESH_NAME;
      // 모프가 없는 모델은 빈 morphAttributes 배열이 남는데, 최신 three 는 이를 "모프 사용"으로 보고 셰이더 컴파일에 실패한다.
      const attrs = (object as THREE.Mesh).geometry.morphAttributes as Record<string, unknown[] | undefined>;
      for (const key of Object.keys(attrs)) if (!attrs[key]?.length) delete attrs[key];
      mmd = true;
    } else if (e === 'glb' || e === 'gltf') {
      const gltf = await new GLTFLoader(manager).loadAsync(url);
      object = gltf.scene;
      animations = gltf.animations;
    } else {
      object = await new FBXLoader(manager).loadAsync(url);
      animations = object.animations;
    }
    let hasMesh = false;
    object.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) hasMesh = true;
    });
    const unsupported = [...new Set([...missing, ...files.map((f) => f.name)])].filter((n) => UNSUPPORTED_RE.test(n));
    return { object, animations, name: main.name.replace(/\.[^.]+$/, ''), hasMesh, mmd, missing: [...missing], unsupported };
  } finally {
    // 로더가 비동기로 텍스처를 읽는 동안 URL 이 유효해야 하므로 약간 늦게 해제
    setTimeout(() => created.forEach((u) => URL.revokeObjectURL(u)), 60_000);
  }
}

/** .vmd 파일을 읽는다 (스켈레톤 없음, 본 이름 기준 키프레임) */
export function loadVmdData(file: File): Promise<VmdMotion> {
  const url = URL.createObjectURL(file);
  return new Promise<VmdMotion>((res, rej) =>
    new MMDLoader().loadVMD(
      url,
      (vmd) => {
        URL.revokeObjectURL(url);
        res(vmd as VmdMotion);
      },
      undefined,
      (err) => {
        URL.revokeObjectURL(url);
        rej(err);
      },
    ),
  );
}

/** root 아래의 본을 모아 Rig 를 만든다 (로드 직후 값을 레스트 포즈로 저장) */
export function buildRig(
  kind: RigKind,
  name: string,
  root: THREE.Object3D,
  clips: THREE.AnimationClip[],
  isMmd: boolean,
  hasMesh: boolean,
): Rig {
  const bones: THREE.Bone[] = [];
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
  });
  if (bones.length === 0) throw new Error('스켈레톤(본)이 없습니다');
  const byName = new Map<string, THREE.Bone>();
  bones.forEach((b, i) => {
    if (!b.name) b.name = `bone_${i}`;
    if (!byName.has(b.name)) byName.set(b.name, b);
  });
  const rest = new Map<THREE.Bone, { q: THREE.Quaternion; p: THREE.Vector3 }>();
  for (const b of bones) rest.set(b, { q: b.quaternion.clone(), p: b.position.clone() });
  return { kind, name, root, bones, byName, clips, isMmd, hasMesh, rest };
}

export function toRig(loaded: Loaded, kind: RigKind): Rig {
  return buildRig(kind, loaded.name, loaded.object, loaded.animations, loaded.mmd, loaded.hasMesh);
}

/** 텍스처/지오메트리/재질 해제 (Rig 를 교체할 때) */
export function disposeRig(rig: Rig) {
  rig.root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if (v instanceof THREE.Texture) v.dispose();
      }
      mat.dispose();
    }
  });
}

/** 입력 파일이 지원하는 메인 형식인지 */
export function isMotionExt(name: string) {
  return ['glb', 'gltf', 'fbx', 'vmd'].includes(ext(name));
}
