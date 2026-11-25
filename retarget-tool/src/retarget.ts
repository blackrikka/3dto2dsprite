import * as THREE from 'three';
import type { MapRow, Rig, RetargetOptions } from './types';

/** 모든 본을 레스트 포즈(로드 직후 local 값)로 되돌린다 */
export function restRig(rig: Rig) {
  for (const b of rig.bones) {
    const r = rig.rest.get(b)!;
    b.quaternion.copy(r.q);
    b.position.copy(r.p);
  }
  rig.root.updateMatrixWorld(true);
}

/** 방향 보정에 쓰는 "자식 본" 후보 (순서대로 첫 번째로 양쪽 매핑된 키를 쓴다) */
function childKeys(key: string): string[] {
  const m = /^(left|right)(.*)$/.exec(key);
  const side = m ? m[1] : '';
  const body = m ? m[2] : key;
  const withSide = (k: string) => side + k;
  if (!side) {
    const c: Record<string, string[]> = {
      spine: ['chest', 'neck'],
      chest: ['upperChest', 'neck'],
      upperChest: ['neck'],
      neck: ['head'],
    };
    return c[body] ?? [];
  }
  const limb: Record<string, string[]> = {
    Shoulder: ['UpperArm'],
    UpperArm: ['LowerArm'],
    LowerArm: ['Hand'],
    Hand: ['MiddleProximal'],
    UpperLeg: ['LowerLeg'],
    LowerLeg: ['Foot'],
    Foot: ['Toes'],
  };
  if (limb[body]) return limb[body].map(withSide);
  const f = /^(Thumb|Index|Middle|Ring|Little)(Proximal|Intermediate)$/.exec(body);
  if (f) return [withSide(f[1] + (f[2] === 'Proximal' ? 'Intermediate' : 'Distal'))];
  return [];
}

function depthOf(b: THREE.Object3D): number {
  let d = 0;
  for (let p = b.parent; p; p = p.parent) d++;
  return d;
}

/**
 * 리그의 "본래 공간" 기준 월드 위치. 뷰어가 소스를 옆에 보여 주려고 root 의 부모(sourceHolder)에
 * 균일 스케일/이동을 주므로, 그 부모 변환을 빼고 잰다. (회전은 뷰어가 주지 않으므로 쿼터니언은 그대로 쓴다)
 */
function restPos(b: THREE.Bone, rig: Rig): THREE.Vector3 {
  const p = b.getWorldPosition(new THREE.Vector3());
  const parent = rig.root.parent;
  if (!parent) return p;
  parent.updateWorldMatrix(true, false);
  return p.applyMatrix4(parent.matrixWorld.clone().invert());
}

interface PreparedItem {
  key: string;
  isHips: boolean;
  srcBone: THREE.Bone;
  tgtBone: THREE.Bone;
  /** 소스 월드 회전/위치 (레스트) */
  Qs0: THREE.Quaternion;
  Ps0: THREE.Vector3;
  /** 타깃 월드 회전/위치 (레스트) */
  Qt0: THREE.Quaternion;
  Pt0: THREE.Vector3;
  /** 방향 보정 */
  A: THREE.Quaternion;
}

export interface Prepared {
  /** 타깃 깊이 오름차순 (부모 먼저) */
  items: PreparedItem[];
  /** 실제 적용 배율 */
  ratio: number;
  /** 자동 계산된 배율 (표시용) */
  autoRatio: number;
}

/** 다리 길이 L = |thigh−shin| + |shin−foot| (왼쪽 우선). 없으면 hips 높이 − 최저 y. 실패 시 0. */
function legLength(rig: Rig, rows: MapRow[], which: 'source' | 'target'): number {
  const bone = (key: string): THREE.Bone | undefined => {
    const name = rows.find((r) => r.key === key)?.[which];
    return name ? rig.byName.get(name) : undefined;
  };
  const wp = (b: THREE.Bone) => restPos(b, rig);
  for (const side of ['left', 'right']) {
    const th = bone(side + 'UpperLeg');
    const sh = bone(side + 'LowerLeg');
    const ft = bone(side + 'Foot');
    if (th && sh && ft) return wp(th).distanceTo(wp(sh)) + wp(sh).distanceTo(wp(ft));
  }
  const hips = bone('hips');
  if (!hips) return 0;
  let minY = Infinity;
  for (const b of rig.bones) minY = Math.min(minY, wp(b).y);
  return wp(hips).y - minY;
}

/** 리타깃 준비: 두 Rig 를 레스트로 되돌리고 대응 행의 기준 자세를 잰다. */
export function prepare(src: Rig, tgt: Rig, rows: MapRow[], opt: RetargetOptions): Prepared {
  restRig(src);
  restRig(tgt);
  src.root.rotation.y = (opt.yawDeg * Math.PI) / 180;
  src.root.parent?.updateWorldMatrix(true, false);
  src.root.updateMatrixWorld(true);
  tgt.root.updateMatrixWorld(true);

  // 양쪽 모두 매핑된 행만 사용
  const map = new Map<string, { sb: THREE.Bone; tb: THREE.Bone }>();
  for (const r of rows) {
    if (!r.enabled || !r.source || !r.target) continue;
    const sb = src.byName.get(r.source);
    const tb = tgt.byName.get(r.target);
    if (sb && tb) map.set(r.key, { sb, tb });
  }

  const items: PreparedItem[] = [];
  for (const [key, { sb, tb }] of map) {
    const Ps0 = restPos(sb, src);
    const Pt0 = tb.getWorldPosition(new THREE.Vector3());
    const A = new THREE.Quaternion();
    if (opt.restFix && key !== 'hips') {
      const ck = childKeys(key).find((c) => map.has(c));
      if (ck) {
        const cm = map.get(ck)!;
        const ds = restPos(cm.sb, src).sub(Ps0);
        const dt = restPos(cm.tb, tgt).sub(Pt0);
        if (ds.lengthSq() > 1e-12 && dt.lengthSq() > 1e-12) {
          A.setFromUnitVectors(dt.normalize(), ds.normalize());
        }
      }
    }
    items.push({
      key,
      isHips: key === 'hips',
      srcBone: sb,
      tgtBone: tb,
      Qs0: sb.getWorldQuaternion(new THREE.Quaternion()),
      Ps0,
      Qt0: tb.getWorldQuaternion(new THREE.Quaternion()),
      Pt0,
      A,
    });
  }
  items.sort((a, b) => depthOf(a.tgtBone) - depthOf(b.tgtBone));

  const Ls = legLength(src, rows, 'source');
  const Lt = legLength(tgt, rows, 'target');
  const autoRatio = Ls > 1e-6 && Number.isFinite(Lt / Ls) ? Lt / Ls : 1;
  const ratio = opt.hipsScale ?? autoRatio;
  return { items, ratio: Number.isFinite(ratio) ? ratio : 1, autoRatio };
}

/** 소스 클립을 타깃 모델에 구워 AnimationClip(`${이름}_retarget`) 을 만든다. */
export function bake(
  src: Rig,
  srcClip: THREE.AnimationClip,
  tgt: Rig,
  prep: Prepared,
  opt: RetargetOptions,
): THREE.AnimationClip {
  const fps = opt.fps > 0 ? opt.fps : 30;
  const dur = Math.max(0, srcClip.duration);
  const N = Math.ceil(dur * fps);
  const times: number[] = [];
  for (let n = 0; n <= N; n++) {
    const t = Math.min(n / fps, dur);
    if (times.length && t <= times[times.length - 1]) continue;
    times.push(t);
  }
  const T = times.length;
  const qArr = prep.items.map(() => new Float32Array(T * 4));
  const pArr = new Map<PreparedItem, Float32Array>();
  for (const it of prep.items) if (it.isHips) pArr.set(it, new Float32Array(T * 3));
  const prevQ: (THREE.Quaternion | null)[] = prep.items.map(() => null);

  src.root.parent?.updateWorldMatrix(true, false);
  const mixer = new THREE.AnimationMixer(src.root);
  // LoopOnce: t == duration 에서 LoopRepeat 가 처음 자세로 감기는 것을 막는다
  const action = mixer.clipAction(srcClip);
  action.setLoop(THREE.LoopOnce, 0);
  action.clampWhenFinished = true;
  action.play();
  try {
    for (let f = 0; f < T; f++) {
      mixer.setTime(times[f]);
      src.root.updateMatrixWorld(true);
      restRig(tgt);

      for (let i = 0; i < prep.items.length; i++) {
        const it = prep.items[i];
        const bone = it.tgtBone;
        const parent = bone.parent ?? tgt.root;
        const rest = tgt.rest.get(bone)!;

        if (it.isHips) {
          const delta = restPos(it.srcBone, src).sub(it.Ps0).multiplyScalar(prep.ratio);
          if (opt.inPlace) delta.x = delta.z = 0;
          parent.updateWorldMatrix(true, false);
          const local = parent.worldToLocal(it.Pt0.clone().add(delta));
          if (!Number.isFinite(local.x + local.y + local.z)) local.copy(rest.p);
          bone.position.copy(local);
          bone.updateMatrixWorld(true);
          local.toArray(pArr.get(it)!, f * 3);
        }

        // D = Qs(t)·Qs0⁻¹ ; want = D·A·Qt0 ; local = parentWorld⁻¹·want
        const Qs = it.srcBone.getWorldQuaternion(new THREE.Quaternion());
        const D = Qs.multiply(it.Qs0.clone().invert());
        const want = D.multiply(it.A).multiply(it.Qt0);
        parent.updateWorldMatrix(true, false);
        const pw = parent.getWorldQuaternion(new THREE.Quaternion());
        const q = pw.invert().multiply(want);
        if (![q.x, q.y, q.z, q.w].every(Number.isFinite)) q.copy(rest.q);
        const prev = prevQ[i];
        if (prev && q.dot(prev) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        prevQ[i] = q.clone();
        bone.quaternion.copy(q);
        bone.updateMatrixWorld(true);
        q.toArray(qArr[i], f * 4);
      }
    }
  } finally {
    restRig(tgt);
    mixer.stopAllAction();
    mixer.uncacheRoot(src.root);
  }

  const tracks: THREE.KeyframeTrack[] = [];
  prep.items.forEach((it, i) => {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${it.tgtBone.uuid}.quaternion`, times, qArr[i]));
    const pa = pArr.get(it);
    if (pa) tracks.push(new THREE.VectorKeyframeTrack(`${it.tgtBone.uuid}.position`, times, pa));
  });
  const last = times[times.length - 1];
  return new THREE.AnimationClip(`${srcClip.name}_retarget`, last > 0 ? last : 1 / fps, tracks);
}
