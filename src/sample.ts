import * as THREE from 'three';

/** 파일 없이도 바로 테스트할 수 있는 박스형 샘플 캐릭터 (+Z 를 바라봄) + 모션 4종. */
export function createSampleCharacter(): { object: THREE.Object3D; animations: THREE.AnimationClip[] } {
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0 });
  const skin = mat(0xf2c6a0), shirt = mat(0x3b82c4), pants = mat(0x4a3b6b), boot = mat(0x5a3a22);
  const hair = mat(0x2b1d14), dark = mat(0x151515), belt = mat(0xd9a441);

  const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    return mesh;
  };
  const node = (name: string, x = 0, y = 0, z = 0) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(x, y, z);
    return o;
  };

  const root = new THREE.Group();
  root.name = 'SampleCharacter';

  const hips = node('Hips', 0, 1.0, 0);
  hips.add(box(0.42, 0.2, 0.26, pants, 0, 0, 0));
  hips.add(box(0.44, 0.06, 0.28, belt, 0, 0.1, 0));
  root.add(hips);

  const spine = node('Spine', 0, 0.1, 0);
  spine.add(box(0.5, 0.52, 0.28, shirt, 0, 0.28, 0));
  hips.add(spine);

  const head = node('Head', 0, 0.6, 0);
  head.add(box(0.3, 0.3, 0.3, skin, 0, 0.16, 0));
  head.add(box(0.32, 0.12, 0.32, hair, 0, 0.35, -0.01));
  head.add(box(0.32, 0.22, 0.1, hair, 0, 0.2, -0.13));
  head.add(box(0.05, 0.06, 0.02, dark, -0.07, 0.17, 0.155));
  head.add(box(0.05, 0.06, 0.02, dark, 0.07, 0.17, 0.155));
  spine.add(head);

  const arm = (side: 'L' | 'R') => {
    const sx = side === 'L' ? -1 : 1;
    const upper = node(`Arm${side}`, sx * 0.33, 0.5, 0);
    upper.add(box(0.14, 0.3, 0.14, shirt, 0, -0.14, 0));
    const fore = node(`Fore${side}`, 0, -0.3, 0);
    fore.add(box(0.12, 0.2, 0.12, skin, 0, -0.1, 0));
    fore.add(box(0.13, 0.12, 0.13, skin, 0, -0.26, 0));
    upper.add(fore);
    spine.add(upper);
  };
  arm('L');
  arm('R');

  const leg = (side: 'L' | 'R') => {
    const sx = side === 'L' ? -1 : 1;
    const thigh = node(`Leg${side}`, sx * 0.12, -0.08, 0);
    thigh.add(box(0.18, 0.46, 0.2, pants, 0, -0.22, 0));
    const shin = node(`Shin${side}`, 0, -0.46, 0);
    shin.add(box(0.15, 0.3, 0.17, pants, 0, -0.15, 0));
    shin.add(box(0.17, 0.14, 0.2, boot, 0, -0.38, 0.01));
    shin.add(box(0.17, 0.08, 0.1, boot, 0, -0.44, 0.1));
    thigh.add(shin);
    hips.add(thigh);
  };
  leg('L');
  leg('R');

  // --- 애니메이션 ---------------------------------------------------------
  type Euler3 = [number, number, number];
  const quatValues = (angles: Euler3[]) => {
    const v: number[] = [];
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    for (const a of angles) {
      e.set(a[0], a[1], a[2]);
      q.setFromEuler(e);
      v.push(q.x, q.y, q.z, q.w);
    }
    return v;
  };
  const sampled = (
    dur: number,
    steps: number,
    fn: (phase: number) => Euler3,
  ): { times: number[]; angles: Euler3[] } => {
    const times: number[] = [], angles: Euler3[] = [];
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      times.push(u * dur);
      angles.push(fn(u * Math.PI * 2));
    }
    return { times, angles };
  };
  const rot = (name: string, dur: number, fn: (p: number) => Euler3, steps = 24) => {
    const { times, angles } = sampled(dur, steps, fn);
    return new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, quatValues(angles));
  };
  const pos = (name: string, dur: number, fn: (p: number) => [number, number, number], steps = 24) => {
    const times: number[] = [], values: number[] = [];
    for (let i = 0; i <= steps; i++) {
      times.push((i / steps) * dur);
      values.push(...fn((i / steps) * Math.PI * 2));
    }
    return new THREE.VectorKeyframeTrack(`${name}.position`, times, values);
  };

  const gait = (name: string, dur: number, p: { leg: number; knee: number; arm: number; elbow: number; lean: number; bob: number }) => {
    const tracks = [
      rot('LegL', dur, (t) => [-p.leg * Math.sin(t), 0, 0]),
      rot('LegR', dur, (t) => [p.leg * Math.sin(t), 0, 0]),
      rot('ShinL', dur, (t) => [p.knee * Math.max(0, Math.cos(t)), 0, 0]),
      rot('ShinR', dur, (t) => [p.knee * Math.max(0, -Math.cos(t)), 0, 0]),
      rot('ArmL', dur, (t) => [p.arm * Math.sin(t), 0, -0.08]),
      rot('ArmR', dur, (t) => [-p.arm * Math.sin(t), 0, 0.08]),
      rot('ForeL', dur, (t) => [-p.elbow - 0.25 * Math.sin(t), 0, 0]),
      rot('ForeR', dur, (t) => [-p.elbow + 0.25 * Math.sin(t), 0, 0]),
      rot('Spine', dur, (t) => [p.lean, 0.12 * Math.sin(t), 0]),
      rot('Head', dur, (t) => [-p.lean * 0.6, -0.08 * Math.sin(t), 0]),
      pos('Hips', dur, (t) => [0, 1.0 + p.bob * Math.cos(2 * t), 0]),
    ];
    return new THREE.AnimationClip(name, dur, tracks);
  };

  const idle = new THREE.AnimationClip('Idle', 2, [
    rot('Spine', 2, (t) => [0.02 + 0.025 * Math.sin(t), 0, 0]),
    rot('Head', 2, (t) => [-0.02 - 0.02 * Math.sin(t - 0.6), 0.05 * Math.sin(t), 0]),
    rot('ArmL', 2, (t) => [0.03 * Math.sin(t), 0, -0.1 - 0.03 * Math.sin(t)]),
    rot('ArmR', 2, (t) => [-0.03 * Math.sin(t), 0, 0.1 + 0.03 * Math.sin(t)]),
    rot('ForeL', 2, () => [-0.15, 0, 0]),
    rot('ForeR', 2, () => [-0.15, 0, 0]),
    pos('Hips', 2, (t) => [0, 1.0 - 0.015 * (0.5 + 0.5 * Math.sin(t)), 0]),
  ]);

  const walk = gait('Walk', 1.0, { leg: 0.7, knee: 0.95, arm: 0.6, elbow: 0.35, lean: 0.06, bob: 0.03 });
  const run = gait('Run', 0.6, { leg: 1.05, knee: 1.5, arm: 1.0, elbow: 1.2, lean: 0.28, bob: 0.06 });

  // 공격(펀치): 키프레임 직접 지정
  const dur = 0.8;
  const t = [0, 0.3, 0.45, 0.7, 1].map((u) => u * dur);
  const q = (a: Euler3[]) => quatValues(a);
  const attack = new THREE.AnimationClip('Attack', dur, [
    new THREE.QuaternionKeyframeTrack('ArmR.quaternion', t, q([[0, 0, 0.08], [0.9, 0, 0.3], [-1.6, 0, 0.1], [-1.1, 0, 0.1], [0, 0, 0.08]])),
    new THREE.QuaternionKeyframeTrack('ForeR.quaternion', t, q([[-0.3, 0, 0], [-1.5, 0, 0], [-0.1, 0, 0], [-0.6, 0, 0], [-0.3, 0, 0]])),
    new THREE.QuaternionKeyframeTrack('ArmL.quaternion', t, q([[0, 0, -0.08], [-0.5, 0, -0.3], [0.4, 0, -0.1], [0.2, 0, -0.1], [0, 0, -0.08]])),
    new THREE.QuaternionKeyframeTrack('ForeL.quaternion', t, q([[-0.3, 0, 0], [-1.3, 0, 0], [-1.3, 0, 0], [-0.9, 0, 0], [-0.3, 0, 0]])),
    new THREE.QuaternionKeyframeTrack('Spine.quaternion', t, q([[0, 0, 0], [0.05, 0.5, 0], [0.1, -0.55, 0], [0.05, -0.25, 0], [0, 0, 0]])),
    new THREE.QuaternionKeyframeTrack('LegL.quaternion', t, q([[0, 0, 0], [0.25, 0, 0], [-0.35, 0, 0], [-0.2, 0, 0], [0, 0, 0]])),
    new THREE.QuaternionKeyframeTrack('LegR.quaternion', t, q([[0, 0, 0], [-0.3, 0, 0], [0.45, 0, 0], [0.2, 0, 0], [0, 0, 0]])),
    new THREE.QuaternionKeyframeTrack('ShinR.quaternion', t, q([[0, 0, 0], [0.4, 0, 0], [0.1, 0, 0], [0.1, 0, 0], [0, 0, 0]])),
    new THREE.VectorKeyframeTrack('Hips.position', t, [0, 1.0, 0, 0, 0.95, 0, 0, 0.96, 0.05, 0, 0.98, 0.02, 0, 1.0, 0]),
  ]);

  return { object: root, animations: [idle, walk, run, attack] };
}
