import * as THREE from 'three';
import { buildRig } from './loaders';
import type { Rig, VmdMotion } from './types';

type Vec3 = [number, number, number];
export interface MmdBoneDef {
  name: string;
  parent: string | null;
  /** 절대 위치 (MMD 단위, 정면 +Z, 캐릭터 왼쪽 = +X) */
  pos: Vec3;
}

const base: MmdBoneDef[] = [
  { name: '全ての親', parent: null, pos: [0, 0, 0] },
  { name: 'センター', parent: '全ての親', pos: [0, 8, 0] },
  { name: 'グルーブ', parent: 'センター', pos: [0, 8, 0] },
  { name: '上半身', parent: 'グルーブ', pos: [0, 11.6, 0] },
  { name: '上半身2', parent: '上半身', pos: [0, 12.8, 0] },
  { name: '首', parent: '上半身2', pos: [0, 15.8, 0] },
  { name: '頭', parent: '首', pos: [0, 16.8, 0] },
  { name: '下半身', parent: 'グルーブ', pos: [0, 11.6, 0] },
];

const FINGERS: [string, string[]][] = [
  ['親指', ['０', '１', '２']],
  ['人指', ['１', '２', '３']],
  ['中指', ['１', '２', '３']],
  ['薬指', ['１', '２', '３']],
  ['小指', ['１', '２', '３']],
];

/** sx = +1 (左) / -1 (右): 右 쪽은 x 부호를 뒤집는다 */
function limbs(side: '左' | '右', sx: 1 | -1): MmdBoneDef[] {
  const p = (x: number, y: number, z: number): Vec3 => [sx * x, y, z];
  const n = (s: string) => side + s;
  const wrist = p(5.1, 11.9, 0);
  const out: MmdBoneDef[] = [
    { name: n('肩'), parent: '上半身2', pos: p(0.4, 15.3, 0) },
    { name: n('腕'), parent: n('肩'), pos: p(1.2, 15.0, 0) },
    { name: n('ひじ'), parent: n('腕'), pos: p(3.2, 13.4, 0) },
    { name: n('手首'), parent: n('ひじ'), pos: wrist },
    { name: n('足'), parent: '下半身', pos: p(0.9, 10.6, 0) },
    { name: n('ひざ'), parent: n('足'), pos: p(1.0, 5.9, 0) },
    { name: n('足首'), parent: n('ひざ'), pos: p(1.1, 1.2, 0) },
    { name: n('つま先'), parent: n('足首'), pos: p(1.1, 0.2, 1.5) },
  ];
  // 손가락: 펼침 없는 단순 체인. i번째 마디 = 손목 + 0.35·(i+1)·dir
  const len = Math.hypot(1.9, 1.5);
  const dir = [(sx * 1.9) / len, -1.5 / len, 0];
  for (const [fname, nums] of FINGERS) {
    let parent = n('手首');
    nums.forEach((num, i) => {
      const k = 0.35 * (i + 1);
      const pos: Vec3 = [wrist[0] + k * dir[0], wrist[1] + k * dir[1], wrist[2]];
      const name = n(fname) + num;
      out.push({ name, parent, pos });
      parent = name;
    });
  }
  return out;
}

export const MMD_BONES: MmdBoneDef[] = [...base, ...limbs('左', 1), ...limbs('右', -1)];

/** MMD 표준 스켈레톤(레스트 회전 = identity)으로 Rig 를 만든다 — VMD 모션 전용 */
export function buildMmdRig(name: string): Rig {
  const root = new THREE.Group();
  root.name = name;
  const abs = new Map<string, Vec3>();
  const bones = new Map<string, THREE.Bone>();
  for (const d of MMD_BONES) {
    const b = new THREE.Bone();
    b.name = d.name;
    const pp: Vec3 = d.parent ? abs.get(d.parent)! : [0, 0, 0];
    b.position.set(d.pos[0] - pp[0], d.pos[1] - pp[1], d.pos[2] - pp[2]);
    (d.parent ? bones.get(d.parent)! : root).add(b);
    bones.set(d.name, b);
    abs.set(d.name, d.pos);
  }
  return buildRig('motion', name, root, [], false, false);
}

/** 테이블에 없는 본은 무시. IK 본에 키가 있으면 skippedIk. */
export function vmdToClip(vmd: VmdMotion, rig: Rig): { clip: THREE.AnimationClip; skippedIk: boolean } {
  const groups = new Map<string, VmdMotion['motions']>();
  let skippedIk = false;
  for (const m of vmd.motions) {
    if (m.boneName.normalize('NFKC').includes('IK')) skippedIk = true;
    let g = groups.get(m.boneName);
    if (!g) groups.set(m.boneName, (g = []));
    g.push(m);
  }
  const tracks: THREE.KeyframeTrack[] = [];
  for (const [name, list] of groups) {
    const bone = rig.byName.get(name);
    if (!bone || name.normalize('NFKC').includes('IK')) continue;
    list.sort((a, b) => a.frameNum - b.frameNum);
    const times = list.map((k) => k.frameNum / 30);
    const rot = list.flatMap((k) => [k.rotation[0], k.rotation[1], k.rotation[2], k.rotation[3]]);
    const rp = rig.rest.get(bone)!.p;
    const pos = list.flatMap((k) => [rp.x + k.position[0], rp.y + k.position[1], rp.z + k.position[2]]);
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone.uuid}.quaternion`, times, rot));
    tracks.push(new THREE.VectorKeyframeTrack(`${bone.uuid}.position`, times, pos));
  }
  const clip = new THREE.AnimationClip('vmd', -1, tracks);
  return { clip, skippedIk };
}
