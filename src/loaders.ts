import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { MMDLoader } from 'three-stdlib';

export interface Loaded {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  name: string;
  hasMesh: boolean;
  /** PMX/PMD 모델 여부 (VMD 모션을 붙일 수 있다) */
  mmd: boolean;
  /** 모델이 참조하지만 함께 선택되지 않아 찾지 못한 텍스처 파일명 */
  missing: string[];
  /** 브라우저가 읽을 수 없는 형식(.psd .tif .dds …)의 텍스처 파일명 */
  unsupported: string[];
}

const IMG_RE = /\.(png|jpe?g|jfif|bmp|tga|tiff?|webp|gif|dds|psd|exr|hdr|ktx2?)$/i;
/** 브라우저(<img>)나 등록된 로더가 읽지 못하는 형식 */
const UNSUPPORTED_RE = /\.(psd|tiff?|dds|exr|hdr|ktx2?)$/i;

export const MAIN_EXT = ['glb', 'gltf', 'fbx', 'obj', 'pmx', 'pmd'];
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

/** MMD 메시를 트랙 이름으로 가리키기 위한 ASCII 이름 (PropertyBinding 정규식은 \w 만 허용) */
export const MMD_MESH_NAME = 'MMDMesh';

interface MeshBuilderLike {
  build(data: object, resourcePath: string, onProgress?: unknown, onError?: (e: unknown) => void): THREE.SkinnedMesh;
}

/**
 * 선택/드롭한 파일들 중 메인 파일(glb/gltf/fbx/obj/pmx/pmd)을 읽는다.
 * .gltf 의 .bin, PMX 의 텍스처처럼 함께 선택된 부속 파일은 (폴더 경로와 무관하게) 파일 이름으로 연결한다.
 */
export async function loadModelFiles(
  files: File[],
  onWarn?: (msg: string) => void,
  /** 텍스처가 (비동기로) 모두 도착했을 때 — 이미 그려 둔 프레임을 다시 그려야 한다 */
  onTexturesLoaded?: () => void,
): Promise<Loaded> {
  const main = files.find((f) => MAIN_EXT.includes(ext(f.name)));
  if (!main) throw new Error('지원하는 파일(.glb .gltf .fbx .obj .pmx .pmd)이 없습니다.');

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
  // .tga 텍스처는 브라우저가 못 읽으므로 전용 로더를 등록한다 (FBX/GLTF/OBJ 공통)
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const clean = url.split('?')[0];
    const hit = urls.get(base(clean));
    if (hit) return hit;
    // 선택되지 않은 텍스처 (임베드된 blob 텍스처는 확장자가 없어 여기에 걸리지 않는다)
    let n = baseName(clean);
    try { n = decodeURIComponent(n); } catch { /* 그대로 */ }
    if (IMG_RE.test(n)) missing.add(n);
    return url;
  });
  // 파일은 찾았지만 읽지 못한 텍스처 (손상, 지원하지 않는 형식 등) — 비동기로 도착하므로 모아서 알린다
  // 텍스처는 모델이 열린 뒤에 도착한다. 그 전에 렌더/캐시된 프레임은 텍스처가 없는 하얀 상태이므로 알려 줘야 한다.
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
      // 텍스처 경로("tex\\body.png")는 위의 URL 변환기가 파일 이름으로 찾아 준다.
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
    } else if (e === 'fbx') {
      object = await new FBXLoader(manager).loadAsync(url);
      animations = object.animations;
    } else {
      object = await new OBJLoader(manager).loadAsync(url);
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

/** VMD 모션을 주어진 MMD 모델에 맞는 AnimationClip 으로 읽는다. */
export async function loadVmd(file: File, mesh: THREE.SkinnedMesh): Promise<THREE.AnimationClip> {
  const url = URL.createObjectURL(file);
  try {
    const clip = await new Promise<THREE.AnimationClip>((res, rej) =>
      new MMDLoader().loadAnimation(url, mesh, (c) => res(c as THREE.AnimationClip), undefined, rej),
    );
    clip.name = file.name.replace(/\.[^.]+$/, '');
    return clip;
  } finally {
    URL.revokeObjectURL(url);
  }
}
