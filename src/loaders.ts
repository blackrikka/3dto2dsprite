import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

export interface Loaded {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
  name: string;
  hasMesh: boolean;
}

const MAIN_EXT = ['glb', 'gltf', 'fbx', 'obj'];
const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';
const base = (n: string) => decodeURIComponent(n.split(/[\\/]/).pop() ?? n).toLowerCase();

/**
 * 선택/드롭한 파일들 중 메인 파일(glb/gltf/fbx/obj)을 읽는다.
 * .gltf 의 .bin/텍스처처럼 함께 선택된 부속 파일은 이름으로 연결한다.
 */
export async function loadModelFiles(files: File[]): Promise<Loaded> {
  const main = files.find((f) => MAIN_EXT.includes(ext(f.name)));
  if (!main) throw new Error('지원하는 파일(.glb .gltf .fbx .obj)이 없습니다.');

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
    if (e === 'glb' || e === 'gltf') {
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
    return { object, animations, name: main.name.replace(/\.[^.]+$/, ''), hasMesh };
  } finally {
    // 로더가 비동기로 텍스처를 읽는 동안 URL 이 유효해야 하므로 약간 늦게 해제
    setTimeout(() => created.forEach((u) => URL.revokeObjectURL(u)), 5000);
  }
}
