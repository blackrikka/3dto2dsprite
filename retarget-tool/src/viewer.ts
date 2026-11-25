import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { restRig } from './retarget';
import type { Rig } from './types';

const SRC_SKELETON_COLOR = '#4fc3f7';

/** 반복은 viewer 가 직접 처리하므로 믹서는 한 번만 재생(끝에서 감기지 않게)한다 */
function playOnce(mixer: THREE.AnimationMixer, clip: THREE.AnimationClip): THREE.AnimationAction {
  const a = mixer.clipAction(clip);
  a.setLoop(THREE.LoopOnce, 0);
  a.clampWhenFinished = true;
  return a.play();
}

/** 3D 미리보기: 타깃(모델)은 원점, 소스(모션)는 옆에 표시 전용으로 배치 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private canvas: HTMLCanvasElement;
  private target: Rig | null = null;
  private source: Rig | null = null;
  private tMixer: THREE.AnimationMixer | null = null;
  private sMixer: THREE.AnimationMixer | null = null;
  private tAction: THREE.AnimationAction | null = null;
  private sAction: THREE.AnimationAction | null = null;
  private tHelper: THREE.SkeletonHelper | null = null;
  private sHelper: THREE.SkeletonHelper | null = null;
  private sourceHolder = new THREE.Group();
  private busy = false;
  private lastFrame = 0;

  time = 0;
  duration = 0;
  playing = false;
  loop = true;
  speed = 1;
  showSource = true;
  showSkeleton = true;
  onTick?: (t: number) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color('#2a2d33');
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(0, 1.5, 5);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.0));
    const dir = new THREE.DirectionalLight(0xffffff, 1.5);
    dir.position.set(2, 4, 3);
    this.scene.add(dir);
    this.scene.add(new THREE.GridHelper(20, 20, 0x555a66, 0x3a3e48));
    this.scene.add(this.sourceHolder);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement ?? canvas);
    this.resize();
    requestAnimationFrame(this.frame);
  }

  private resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** 본들의 월드 위치 범위 */
  private boneBox(rig: Rig): THREE.Box3 {
    rig.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    for (const b of rig.bones) box.expandByPoint(b.getWorldPosition(p));
    if (box.isEmpty()) box.set(new THREE.Vector3(), new THREE.Vector3());
    return box;
  }

  setTarget(rig: Rig | null) {
    if (this.target) {
      this.scene.remove(this.target.root);
      this.tMixer?.stopAllAction();
      this.tMixer?.uncacheRoot(this.target.root);
      if (this.tHelper) {
        this.scene.remove(this.tHelper);
        this.tHelper.dispose();
      }
    }
    this.tMixer = null;
    this.tAction = null;
    this.tHelper = null;
    this.target = rig;
    if (rig) {
      this.scene.add(rig.root);
      this.tMixer = new THREE.AnimationMixer(rig.root);
      if (!rig.hasMesh) {
        this.tHelper = new THREE.SkeletonHelper(rig.root);
        this.scene.add(this.tHelper);
      }
    }
    this.updateSourcePlacement();
    this.fitCamera();
    this.applyTime();
    this.updateDuration();
  }

  setSource(rig: Rig | null) {
    if (this.source) {
      this.sourceHolder.remove(this.source.root);
      this.sMixer?.stopAllAction();
      this.sMixer?.uncacheRoot(this.source.root);
    }
    if (this.sHelper) {
      this.sourceHolder.remove(this.sHelper);
      this.sHelper.dispose();
      this.sHelper = null;
    }
    this.sMixer = null;
    this.sAction = null;
    this.source = rig;
    if (rig) {
      this.sourceHolder.add(rig.root);
      this.sMixer = new THREE.AnimationMixer(rig.root);
      this.sHelper = new THREE.SkeletonHelper(rig.root);
      const mat = this.sHelper.material as THREE.LineBasicMaterial;
      mat.vertexColors = false;
      mat.color.set(SRC_SKELETON_COLOR);
      this.sourceHolder.add(this.sHelper);
    }
    this.updateSourcePlacement();
    this.fitCamera();
    this.applyTime();
    this.updateDuration();
  }

  /** 타깃과 소스(배치 후) 전체가 화면에 들어오도록 카메라를 맞춘다 (불러올 때만 호출) */
  private fitCamera() {
    if (!this.target) return;
    const box = this.boneBox(this.target);
    if (this.source) box.union(this.boneBox(this.source));
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const distY = size.y / 2 / tanHalf;
    const distX = size.x / 2 / (tanHalf * this.camera.aspect);
    const dist = Math.max(distY, distX, 0.5) * 1.3 + Math.max(size.z, 0);
    this.controls.target.copy(c);
    this.camera.position.set(c.x, c.y + size.y * 0.1, c.z + dist);
    this.camera.near = dist / 200;
    this.camera.far = dist * 200;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 소스를 타깃 옆(-x)에 두고, 키를 타깃에 맞춘다. 표시 전용 균일 스케일. */
  private updateSourcePlacement() {
    this.sourceHolder.position.set(0, 0, 0);
    this.sourceHolder.scale.setScalar(1);
    if (!this.source || !this.target) return;
    const sb = this.boneBox(this.source);
    const tb = this.boneBox(this.target);
    const sh = Math.max(sb.max.y - sb.min.y, 1e-6);
    const th = Math.max(tb.max.y - tb.min.y, 1e-6);
    const tw = Math.max(tb.max.x - tb.min.x, tb.max.z - tb.min.z);
    const s = th / sh;
    this.sourceHolder.scale.setScalar(s);
    this.sourceHolder.position.set(-Math.max(1.2 * tw, th), tb.min.y - sb.min.y * s, 0);
    this.sourceHolder.updateMatrixWorld(true);
  }

  /** 재생할 결과 클립과 원본 소스 클립 (null 이면 해당 쪽은 레스트/비움) */
  playClip(clip: THREE.AnimationClip | null, srcClip: THREE.AnimationClip | null) {
    this.tMixer?.stopAllAction();
    this.sMixer?.stopAllAction();
    this.tAction = clip && this.tMixer ? playOnce(this.tMixer, clip) : null;
    this.sAction = srcClip && this.sMixer ? playOnce(this.sMixer, srcClip) : null;
    this.duration = clip?.duration ?? srcClip?.duration ?? 0;
    this.setTime(Math.min(this.time, this.duration));
  }

  setTime(t: number) {
    this.time = Math.max(0, Math.min(t, this.duration));
    this.applyTime();
    this.onTick?.(this.time);
  }

  private updateDuration() {
    this.duration = this.tAction?.getClip().duration ?? this.sAction?.getClip().duration ?? 0;
    this.time = Math.min(this.time, this.duration);
  }

  /** 내보내기 등 본 상태를 직접 읽어야 할 때: 재생을 멈추고 타깃을 레스트로 둔 채 fn 실행 */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const was = this.playing;
    this.playing = false;
    this.busy = true;
    try {
      if (this.target) restRig(this.target);
      return await fn();
    } finally {
      this.busy = false;
      this.playing = was;
    }
  }

  private applyTime() {
    if (this.busy) return;
    if (this.target) {
      if (this.tAction && this.tMixer) this.tMixer.setTime(this.time);
      else restRig(this.target);
    }
    if (this.source) {
      if (this.sAction && this.sMixer) this.sMixer.setTime(this.time);
      this.source.root.visible = this.showSource;
    }
    if (this.sHelper) this.sHelper.visible = this.showSkeleton;
  }

  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    if (this.playing) {
      if (this.duration <= 0) {
        this.playing = false;
      } else {
        let t = this.time + dt * this.speed;
        if (this.loop) t %= this.duration;
        else if (t >= this.duration) {
          t = this.duration;
          this.playing = false;
        }
        this.time = t;
      }
    }
    this.applyTime();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.onTick?.(this.time);
  };
}
