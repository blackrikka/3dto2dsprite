import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CCDIKSolver, MMDAnimationHelper } from 'three-stdlib';
import { Settings } from './types';
import { MMD_MESH_NAME } from './loaders';

export interface ClipEntry {
  name: string;
  source: string;
  clip: THREE.AnimationClip;
  matched: number;
  total: number;
}

const IN_PLACE_RE = /hips|root|pelvis|armature|bip0?01$|^センター$|^全ての親$/i;
const MMD_BONE_TRACK_RE = /^(?:[^.\[]*)\.bones\[(.+)\]\.(position|quaternion|scale)$/;
const MMD_MORPH_TRACK_RE = /^(?:[^.\[]*)\.morphTargetInfluences\[(.+)\]$/;

/** 노드 이름을 비교용으로 정규화 (mixamorig: 접두어 등 무시, 일본어 등 유니코드 문자는 유지) */
const normName = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '').replace(/^mixamorig/, '');

function makeInPlace(clip: THREE.AnimationClip): THREE.AnimationClip {
  const c = clip.clone();
  for (const t of c.tracks) {
    if (!t.name.endsWith('.position')) continue;
    // MMD: "MMDMesh.bones[センター].position" → 본 이름만 꺼낸다
    const mmdBone = /\.bones\[(.+)\]\.position$/.exec(t.name);
    const node = mmdBone ? mmdBone[1] : t.name.slice(0, -'.position'.length);
    if (!IN_PLACE_RE.test(node)) continue;
    const v = t.values.slice();
    for (let i = 0; i < v.length; i += 3) {
      v[i] = v[0]; // X, Z 이동 고정 (Y 상하 움직임은 유지)
      v[i + 2] = v[2];
    }
    t.values = v;
  }
  return c;
}

/**
 * 3D 씬 관리: 모델/애니메이션, 뷰포트 카메라, 스프라이트용 직교 카메라와 오프스크린 렌더.
 */
export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** 방향(yaw) 회전을 담당 */
  readonly rig = new THREE.Group();
  /** 모델 정규화(중앙 정렬/바닥 0) 오프셋 */
  readonly holder = new THREE.Group();
  readonly spriteCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  readonly viewCam = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  readonly controls: OrbitControls;

  private ambientLight = new THREE.AmbientLight(0xffffff, 1);
  private sun = new THREE.DirectionalLight(0xffffff, 2);
  private grid: THREE.GridHelper;
  private rt: THREE.WebGLRenderTarget | null = null;

  model: THREE.Object3D | null = null;
  modelName = '';
  mixer: THREE.AnimationMixer | null = null;
  clips: ClipEntry[] = [];
  activeClip = -1;
  modelVersion = 0;

  /** MMD(PMX/PMD) 모델이면 IK/부여(grant) 솔버를 들고 있다 */
  mmd: { mesh: THREE.SkinnedMesh; ik: CCDIKSolver; grant: { update(): void } } | null = null;

  /** 믹서가 마지막으로 쓴 본 값(IK 적용 전). AnimationMixer 는 "직전 적용값과 같으면 쓰기를 생략"하므로 IK 가 바꾼 값을 되돌려 둬야 한다. */
  private mmdBackup: { pos: Float32Array; quat: Float32Array } | null = null;

  private actionClip: THREE.AnimationClip | null = null;
  private action: THREE.AnimationAction | null = null;
  private variants = new WeakMap<THREE.AnimationClip, THREE.AnimationClip>();
  private gradient: { steps: number; tex: THREE.DataTexture } | null = null;
  private vertexCount = 0;
  private bounds: { key: string; radius: number; cy: number } | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x262a33);
    this.scene.add(this.ambientLight, this.sun, this.sun.target);
    this.scene.add(this.rig);
    this.rig.add(this.holder);

    this.grid = new THREE.GridHelper(4, 16, 0x5a6275, 0x3a4050);
    this.grid.layers.set(1);
    this.scene.add(this.grid);
    this.viewCam.layers.enable(1);

    this.controls = new OrbitControls(this.viewCam, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.frameViewport(1, 0.5);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  resize(): void {
    const w = Math.max(1, this.host.clientWidth), h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.viewCam.aspect = w / h;
    this.viewCam.updateProjectionMatrix();
  }

  private viewInfo = { radius: 1, cy: 0.5 };

  private frameViewport(radius: number, cy: number): void {
    this.viewInfo = { radius, cy };
    this.viewDefault();
    const g = Math.max(2, Math.ceil(radius * 2.5));
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(g * 2, g * 8, 0x5a6275, 0x3a4050);
    this.grid.layers.set(1);
    this.scene.add(this.grid);
  }

  private placeView(radius: number, cy: number, dir: THREE.Vector3): void {
    const dist = radius * 3.2;
    this.viewCam.position.copy(dir).normalize().multiplyScalar(dist).add(new THREE.Vector3(0, cy, 0));
    this.viewCam.near = radius * 0.02;
    this.viewCam.far = radius * 60;
    this.viewCam.updateProjectionMatrix();
    this.controls.target.set(0, cy, 0);
    this.controls.update();
  }

  /** 기본 3/4 시점 */
  viewDefault(): void {
    const { radius, cy } = this.viewInfo;
    this.placeView(radius, cy, new THREE.Vector3(0.55, 0.7 * 0.8, 1));
  }

  /** 스프라이트 카메라와 같은 방향(기울기)에서 보는 시점. pitch 를 0 으로 주면 정면 */
  viewSprite(pitchDeg: number): void {
    const b = this.bounds;
    const { radius, cy } = b ?? this.viewInfo;
    const p = THREE.MathUtils.degToRad(pitchDeg);
    this.placeView(radius, cy, new THREE.Vector3(0, Math.sin(p), Math.cos(p)));
  }

  // --- 모델 --------------------------------------------------------------

  setModel(obj: THREE.Object3D, animations: THREE.AnimationClip[], name: string): void {
    if (this.model) {
      this.holder.remove(this.model);
      this.disposeObject(this.model);
    }
    this.mixer?.stopAllAction();
    this.action = null;
    this.actionClip = null;
    this.mmd = null;
    this.mmdBackup = null;
    this.rig.rotation.y = 0;
    this.holder.position.set(0, 0, 0);

    this.model = obj;
    this.modelName = name;
    this.holder.add(obj);
    this.holder.updateMatrixWorld(true);

    const sk = obj as THREE.SkinnedMesh;
    const mmdData = sk.isSkinnedMesh ? (sk.geometry.userData.MMD as { iks: never[] } | undefined) : undefined;
    this.mmd = mmdData
      ? {
          mesh: sk,
          ik: new CCDIKSolver(sk, mmdData.iks),
          grant: new MMDAnimationHelper().createGrantSolver(sk) as { update(): void },
        }
      : null;

    // 정규화: 바닥을 y=0, 가로 중심을 원점으로
    const box = new THREE.Box3().setFromObject(obj, true);
    const c = box.getCenter(new THREE.Vector3());
    this.holder.position.set(-c.x, -box.min.y, -c.z);
    this.holder.updateMatrixWorld(true);

    this.vertexCount = 0;
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        this.vertexCount += m.geometry.attributes.position?.count ?? 0;
        m.frustumCulled = false; // 스키닝 변형 시 컬링 오류 방지
        m.userData.orig = m.material;
        const toon = (src: THREE.Material) => {
          const s = src as THREE.MeshStandardMaterial;
          return new THREE.MeshToonMaterial({
            color: s.color ? s.color.clone() : new THREE.Color(0xffffff),
            map: s.map ?? null,
            vertexColors: s.vertexColors ?? false,
            side: s.side,
            transparent: s.transparent,
            opacity: s.opacity,
            alphaTest: s.alphaTest,
            emissive: s.emissive ? s.emissive.clone() : new THREE.Color(0),
            emissiveMap: s.emissiveMap ?? null,
          });
        };
        m.userData.toon = Array.isArray(m.material) ? m.material.map(toon) : toon(m.material);
      }
    });

    this.mixer = new THREE.AnimationMixer(this.holder);
    this.clips = [];
    this.addClips(animations, name);
    this.activeClip = this.clips.length ? 0 : -1;
    this.modelVersion++;
    this.bounds = null;

    const size = box.getSize(new THREE.Vector3());
    const radius = Math.hypot(size.x, size.y, size.z) / 2;
    this.frameViewport(radius, size.y / 2);
  }

  private disposeObject(obj: THREE.Object3D): void {
    obj.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry.dispose();
      for (const key of ['orig', 'toon']) {
        const v = m.userData[key];
        (Array.isArray(v) ? v : [v]).forEach((x: THREE.Material | undefined) => x?.dispose());
      }
    });
  }

  /** 모션 추가. 본 이름을 모델과 맞춰 보며 매칭 수를 보고한다. */
  addClips(clips: THREE.AnimationClip[], source: string): ClipEntry[] {
    const added: ClipEntry[] = [];
    const lookup = new Map<string, string>();
    this.holder.traverse((o) => {
      if (o.name) lookup.set(normName(o.name), THREE.PropertyBinding.sanitizeNodeName(o.name));
    });
    for (const src of clips) {
      const clip = src.clone();
      let matched = 0;
      for (const t of clip.tracks) {
        const mmd = this.mmd;
        const bone = MMD_BONE_TRACK_RE.exec(t.name);
        const morph = MMD_MORPH_TRACK_RE.exec(t.name);
        if (mmd && (bone || morph)) {
          // VMD 트랙(".bones[이름].position")은 믹서 루트가 메시일 때만 풀리므로 메시 이름을 앞에 붙인다.
          if (bone && mmd.mesh.skeleton.getBoneByName(bone[1])) matched++;
          if (morph) matched++;
          t.name = MMD_MESH_NAME + t.name.slice(t.name.indexOf('.'));
          continue;
        }
        const dot = t.name.indexOf('.');
        if (dot < 0) continue;
        const node = t.name.slice(0, dot);
        const mapped = lookup.get(normName(node));
        if (mapped) {
          matched++;
          t.name = mapped + t.name.slice(dot);
        }
      }
      const entry: ClipEntry = {
        name: clip.name || `clip${this.clips.length + 1}`,
        source,
        clip,
        matched,
        total: clip.tracks.length,
      };
      this.clips.push(entry);
      added.push(entry);
    }
    return added;
  }

  get duration(): number {
    return this.activeClip >= 0 ? this.clips[this.activeClip].clip.duration : 0;
  }

  // --- 설정 반영 -----------------------------------------------------------

  private gradientMap(steps: number): THREE.DataTexture {
    if (this.gradient?.steps === steps) return this.gradient.tex;
    this.gradient?.tex.dispose();
    const res = steps * 8;
    const data = new Uint8Array(res);
    for (let k = 0; k < res; k++) {
      const dotNL = ((k + 0.5) / res) * 2 - 1;
      const band = Math.min(steps - 1, Math.floor(Math.max(dotNL, 0) * steps));
      data[k] = Math.round((255 * (band + 1)) / steps);
    }
    const tex = new THREE.DataTexture(data, res, 1, THREE.RedFormat);
    tex.minFilter = tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.gradient = { steps, tex };
    return tex;
  }

  configure(s: Settings): void {
    // 셰이딩
    const grad = this.gradientMap(s.toonSteps);
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const toon = m.userData.toon as THREE.MeshToonMaterial | THREE.MeshToonMaterial[];
      (Array.isArray(toon) ? toon : [toon]).forEach((t) => (t.gradientMap = grad));
      m.material = s.shading === 'toon' ? toon : m.userData.orig;
    });

    // 조명 (카메라 기준으로 고정)
    const az = THREE.MathUtils.degToRad(s.lightAzimuth), el = THREE.MathUtils.degToRad(s.lightElevation);
    this.sun.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(10);
    this.sun.intensity = s.lightIntensity;
    this.ambientLight.intensity = s.ambient;

    // 모션 액션
    this.ensureAction(s);
    this.ensureBounds(s);
    this.configureCamera(s);
  }

  private ensureAction(s: Settings): void {
    if (!this.mixer) return;
    const entry = this.activeClip >= 0 ? this.clips[this.activeClip] : null;
    let clip: THREE.AnimationClip | null = null;
    if (entry) {
      clip = entry.clip;
      if (s.inPlace) {
        let v = this.variants.get(entry.clip);
        if (!v) this.variants.set(entry.clip, (v = makeInPlace(entry.clip)));
        clip = v;
      }
    }
    if (clip !== this.actionClip) {
      this.mixer.stopAllAction();
      // 이전 모션의 IK 잔여물 제거: 기본 자세로 복귀
      this.mmd?.mesh.skeleton.pose();
      this.mmdBackup = null;
      this.actionClip = clip;
      this.action = clip ? this.mixer.clipAction(clip) : null;
      this.bounds = null;
    }
    if (this.action) {
      this.action.setLoop(s.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
      this.action.clampWhenFinished = true;
    }
  }

  /** 애니메이션 전체에서 모델이 차지하는 영역(구)을 구해 카메라를 고정한다. */
  private ensureBounds(s: Settings): void {
    const key = `${this.modelVersion}|${this.activeClip}|${s.inPlace}|${s.loop}`;
    if (this.bounds?.key === key) return;
    const yaw = this.rig.rotation.y;
    this.rig.rotation.y = 0;
    const precise = this.vertexCount < 250_000;
    const box = new THREE.Box3(), union = new THREE.Box3();
    const steps = this.action ? 16 : 1;
    let radiusXZ = 0;
    for (let k = 0; k < steps; k++) {
      this.pose((this.duration * k) / steps);
      this.holder.updateMatrixWorld(true);
      box.setFromObject(this.holder, precise);
      if (box.isEmpty()) continue;
      union.union(box);
      const mx = Math.max(Math.abs(box.min.x), Math.abs(box.max.x));
      const mz = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
      radiusXZ = Math.max(radiusXZ, Math.hypot(mx, mz));
    }
    this.rig.rotation.y = yaw;
    if (union.isEmpty()) {
      this.bounds = { key, radius: 1, cy: 0.5 };
      return;
    }
    const h = union.max.y - union.min.y;
    this.bounds = {
      key,
      radius: Math.max(1e-4, Math.hypot(radiusXZ, h / 2)),
      cy: (union.max.y + union.min.y) / 2,
    };
  }

  private configureCamera(s: Settings): void {
    const b = this.bounds!;
    const aspect = s.width / s.height;
    const halfH = (b.radius * 1.06) / Math.min(1, aspect) / (s.zoom / 100);
    const halfW = halfH * aspect;
    const upp = (2 * halfH) / s.height; // 픽셀당 월드 단위
    const cam = this.spriteCam;
    cam.left = -halfW - s.offsetX * upp;
    cam.right = halfW - s.offsetX * upp;
    cam.bottom = -halfH - s.offsetY * upp;
    cam.top = halfH - s.offsetY * upp;
    const dist = b.radius * 4;
    const p = THREE.MathUtils.degToRad(s.pitch);
    cam.position.set(0, b.cy + Math.sin(p) * dist, Math.cos(p) * dist);
    cam.near = Math.max(1e-3, dist - b.radius * 2.5);
    cam.far = dist + b.radius * 2.5;
    cam.up.set(0, 1, 0);
    cam.lookAt(0, b.cy, 0);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
  }

  // --- 포즈/렌더 -----------------------------------------------------------

  private pose(time: number): void {
    if (!this.mixer || !this.action) return;
    const mmd = this.mmd;
    const bones = mmd?.mesh.skeleton.bones;
    if (bones && this.mmdBackup) {
      // 이전 포즈의 IK/부여 결과를 지우고 믹서가 쓴 값으로 복원 (임의 시간 접근을 결정적으로 만든다)
      const { pos, quat } = this.mmdBackup;
      bones.forEach((b, i) => {
        b.position.fromArray(pos, i * 3);
        b.quaternion.fromArray(quat, i * 4);
      });
    }
    this.action.reset();
    this.action.play();
    this.mixer.setTime(time);
    if (mmd && bones) {
      const pos = new Float32Array(bones.length * 3), quat = new Float32Array(bones.length * 4);
      bones.forEach((b, i) => {
        b.position.toArray(pos, i * 3);
        b.quaternion.toArray(quat, i * 4);
      });
      this.mmdBackup = { pos, quat };
      mmd.mesh.updateMatrixWorld(true);
      mmd.ik.update();
      mmd.grant.update();
    }
  }

  setPose(dir: number, dirs: number, time: number): void {
    this.rig.rotation.y = (dir / dirs) * Math.PI * 2;
    this.pose(time);
    this.rig.updateMatrixWorld(true);
  }

  /** 스프라이트 카메라로 w×h 로 렌더해 RGBA(위→아래) 를 돌려준다. */
  renderRaw(w: number, h: number): Uint8ClampedArray {
    const r = this.renderer;
    if (!this.rt || this.rt.width !== w || this.rt.height !== h) {
      this.rt?.dispose();
      this.rt = new THREE.WebGLRenderTarget(w, h, {
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        samples: 0,
      });
      this.rt.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const bg = this.scene.background;
    this.scene.background = null;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear();
    r.render(this.scene, this.spriteCam);
    const buf = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(this.rt, 0, 0, w, h, buf);
    r.setRenderTarget(null);
    r.setClearColor(prevColor, prevAlpha);
    this.scene.background = bg;

    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      out.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }
    return out;
  }

  renderViewport(): void {
    this.controls.update();
    this.renderer.render(this.scene, this.viewCam);
  }
}
