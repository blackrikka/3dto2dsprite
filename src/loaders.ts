import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MMDLoader } from 'three-stdlib';

export interface Loaded {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  name: string;
  hasMesh: boolean;
  /** PMX/PMD 모델 여부 (VMD 모션을 붙일 수 있다) */
  mmd: boolean;
}

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
export async function loadModelFiles(files: File[]): Promise<Loaded> {
  const main = files.find((f) => MAIN_EXT.includes(ext(f.name)));
  if (!main) throw new Error('지원하는 파일(.glb .gltf .fbx .obj .pmx .pmd)이 없습니다.');

  const urls = new Map<string, string>();
  const created: string[] = [];
  for (const f of files) {
    const u = URL.createObjectURL(f);
    created.push(u);
    urls.set(base(f.name), u);
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (url.startsWith('data:')) return url;
    const hit = urls.get(base(url.split('?')[0]));
    return hit ?? url;
  });

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
    return { object, animations, name: main.name.replace(/\.[^.]+$/, ''), hasMesh, mmd };
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
