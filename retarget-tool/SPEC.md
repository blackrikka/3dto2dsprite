# 리타깃 툴 (retarget-tool) — 구현 스펙

모델과 모션을 넣으면 모션의 본을 모델의 본에 자동으로 대응시키고, 모션을 모델에 맞게 리타깃해 미리보기/내보내기하는 독립 앱.
구현자는 이 문서만 보고 그대로 만든다. 모호하면 **더 단순한 쪽**을 고른다. UI 문자열은 전부 한국어.

## 0. 프로젝트 뼈대 (`vfx-maker/` 구조를 그대로 따른다)
```
retarget-tool/
  package.json      name "retarget-tool", type module, scripts: dev "vite", build "tsc --noEmit && vite build", preview "vite preview"
                    dependencies: three ^0.187.0, three-stdlib ^2.36.1
                    devDependencies: @types/three ^0.187.0, typescript ^7.0.2, vite ^8.3.8
  tsconfig.json     vfx-maker/tsconfig.json 복사 (strict, noUnusedLocals/Parameters)
  vite.config.ts    vfx-maker/vite.config.ts 복사 (base './' → 오프라인 file:// 동작)
  index.html        lang="ko", <title>리타깃 툴</title>, <script type="module" src="/src/main.ts">
  src/types.ts  loaders.ts  mmdSkeleton.ts  bones.ts  retarget.ts  viewer.ts  ui.ts  io.ts  main.ts  style.css
```
루트 앱(`../src`)을 import 하지 않는다. 필요한 코드는 **복사**한다. 네트워크/CDN 사용 금지(폰트 포함).
사용하는 API (node_modules 에서 존재 확인함):
- `three/addons/loaders/GLTFLoader.js`, `FBXLoader.js`, `TGALoader.js`, `three/addons/controls/OrbitControls.js`
- `three/addons/exporters/GLTFExporter.js` → `new GLTFExporter().parseAsync(root, { binary: true, animations: [clip], onlyVisible: true })` (ArrayBuffer 반환)
- `three-stdlib` 의 `MMDLoader`: `loadPMX/loadPMD`(루트 loaders.ts 방식), `loadVMD(url, onLoad, onProgress, onError)` → `onLoad(vmd: object)`;
  vmd 는 `{ motions: { boneName: string; frameNum: number; position: number[3]; rotation: number[4] /*x,y,z,w*/ }[] }` (이미 오른손 좌표계로 변환됨, 30fps)
- `THREE.SkeletonHelper`, `THREE.AnimationMixer`(`setTime`), `QuaternionKeyframeTrack`, `VectorKeyframeTrack`, `Quaternion.setFromUnitVectors`, `Object3D.getWorldQuaternion/getWorldPosition/worldToLocal/updateWorldMatrix`
- 트랙 이름은 **`${bone.uuid}.quaternion` / `${bone.uuid}.position`** 을 쓴다 (`PropertyBinding.findNode` 가 uuid 도 찾고, GLTFExporter 도 findNode 로 노드를 찾는다 → 한글/일본어/중복 이름 문제 없음).

## 1. 타입 (`src/types.ts`)
```ts
export interface Rig {
  kind: 'model' | 'motion'; name: string; root: THREE.Object3D;
  bones: THREE.Bone[];                 // root.traverse 순서(부모 먼저)
  byName: Map<string, THREE.Bone>;     // 이름 중복이면 첫 번째만, 빈 이름은 `bone_${i}` 로 rename
  clips: THREE.AnimationClip[]; isMmd: boolean; hasMesh: boolean;
  rest: Map<THREE.Bone, { q: THREE.Quaternion; p: THREE.Vector3 }>;  // 로드 직후 local 값 복제
}
export interface MapRow { key: string; label: string; source: string | null; target: string | null;
  enabled: boolean; confidence: number /*0~1*/; custom?: boolean }
export interface RetargetOptions { fps: number /*기본 30*/; inPlace: boolean; restFix: boolean /*기본 true*/;
  yawDeg: 0 | 90 | 180 | 270; hipsScale: number | null /*null=자동(다리 길이 비)*/ }
export interface MappingFile { version: 1; source: string; target: string; rows: { key: string; source: string | null; target: string | null; enabled: boolean }[]; options: RetargetOptions }
```

## 2. 입력 (`src/loaders.ts`, `src/mmdSkeleton.ts`)
- `loaders.ts`: 루트 `src/loaders.ts` 의 `loadModelFiles` 를 복사(OBJ 제거, MAIN_EXT = glb gltf fbx pmx pmd). 추가:
  - `loadVmdData(file: File): Promise<{ motions: VmdMotion[] }>` — blob URL → `new MMDLoader().loadVMD(url, res, undefined, rej)`, 끝나면 revoke.
  - `toRig(loaded, kind): Rig` — bones 수집(`o.isBone`), rest 저장. bones 가 0이면 `throw new Error('스켈레톤(본)이 없습니다')`.
- 모델 입력: .glb .gltf .fbx .pmx .pmd (+ 텍스처·.bin 부속 파일 다중 선택). 모션 입력: .glb .gltf .fbx .vmd.
  - glb/gltf/fbx 모션: `loadModelFiles` 후 `animations.length === 0` 이면 오류 `'모션 파일에 애니메이션이 없습니다'`. 클립 여러 개면 클립 드롭다운.
  - .vmd 모션: 스켈레톤이 없으므로 `mmdSkeleton.ts` 의 표준 MMD 스켈레톤을 만들어 그 위의 클립으로 바꾼다.
- `mmdSkeleton.ts`:
  - `MMD_BONES: { name: string; parent: string | null; pos: [number, number, number] }[]` (MMD 단위, 정면 +Z, 캐릭터 왼쪽 = +X, rest 회전은 모두 identity).
    중앙: 全ての親(null,0,0,0) → センター(0,8,0) → グルーブ(0,8,0) → 上半身(0,11.6,0) → 上半身2(0,12.8,0) → 首(0,15.8,0) → 頭(0,16.8,0); グルーブ → 下半身(0,11.6,0).
    왼쪽(오른쪽은 이름 左→右, x 부호 반전): 上半身2 → 左肩(0.4,15.3,0) → 左腕(1.2,15.0,0) → 左ひじ(3.2,13.4,0) → 左手首(5.1,11.9,0);
    下半身 → 左足(0.9,10.6,0) → 左ひざ(1.0,5.9,0) → 左足首(1.1,1.2,0) → 左つま先(1.1,0.2,1.5).
    손가락(부모 左手首): 親指０,１,２ / 人指１,２,３ / 中指１,２,３ / 薬指１,２,３ / 小指１,２,３ — 각 손가락 체인의 i번째(0..2) 위치 = 手首 + (0.35·(i+1))·normalize(1.9,−1.5,0). (펼침 없음, 단순 체인)
  - `buildMmdRig(name): Rig` — 위 테이블로 Bone 생성(pos = 부모 대비 차이), Group root 아래 붙임.
  - `vmdToClip(vmd, rig): { clip: THREE.AnimationClip; skippedIk: boolean }` — boneName 별로 그룹, frameNum 정렬, time = frameNum/30.
    quaternion 트랙 = rotation 그대로, position 트랙 = rest.p + position. 테이블에 없는 본은 무시; 이름에 `IK`(NFKC 후)가 들어간 본에 키가 있으면 skippedIk = true.
    보간은 선형(VMD 베지어 무시). 키가 1개뿐인 본도 트랙 생성.
  - skippedIk 면 경고: `'VMD 의 IK(足ＩＫ 등) 모션은 지원하지 않습니다 — 다리가 기본 자세로 남을 수 있습니다'`.

## 3. 본 대응 (`src/bones.ts`)
캐노니컬 키(55개, 순서 = 표 행 순서): `hips spine chest upperChest neck head` + 좌/우 각각 `Shoulder UpperArm LowerArm Hand UpperLeg LowerLeg Foot Toes`
+ 좌/우 각각 `Thumb Index Middle Ring Little` × `Proximal Intermediate Distal`. 키 이름 예: `leftUpperArm`, `rightIndexDistal`.
라벨: 엉덩이 척추 가슴 윗가슴 목 머리 / 왼쪽·오른쪽 + 어깨 위팔 아래팔 손 허벅지 정강이 발 발가락 / 엄지 검지 중지 약지 새끼 + 1 2 3.

`parseName(raw): { side: 'left' | 'right' | ''; core: string; finger?: { f: Finger; seg: 0|1|2 } } | null` (null = 제외):
1. `s = raw.normalize('NFKC')`, `s = s.split(/[:|]/).pop()` (`mixamorig:Hips`, `Armature|Hips`).
2. 방향: `^左`/`^右` → 제거; 아니면 소문자에 `left`/`right` → 제거; 아니면 `/(^|[^a-z])([lr])([^a-z]|$)/i` (`Bip01 L Thigh`, `thigh_l`, `hand.L`, `L_Hand`) → 그 글자 제거; 아니면 원문이 `/^[LR](?=[A-Z])/` (`LHand`) → 제거.
3. `core = 나머지.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')` 후 접두어 반복 제거: `mixamorig\d*`, `valvebipedbip01`, `bip0*1`, `ccbase`, `jbip[clr]?`, `def`, `org`.
4. 제외(→ null): core 에 `ik`(끝·처음 포함), `twist`, `捩`, `roll`, `cancel`, `キャンセル`, `end`, `nub`, `tip`, `dummy`, `ダミー`, `pole`, `target` 포함, 또는 `先` 으로 끝나지만 `つま先` 아님.
5. 손가락: 손가락 단어 `thumb|親指`→Thumb, `index|人差指|人指`→Index, `middle|中指`→Middle, `ring|薬指`→Ring, `little|pinky|小指`→Little.
   마디: `proximal|intermediate|distal` 단어 우선, 아니면 끝 숫자: 親指 은 0/1/2 → seg 0/1/2, 그 외는 1/2/3 → 0/1/2 (숫자 4 이상 → null). 숫자 없으면 seg 0.

`ALIASES: Record<string /*side 없는 키*/, string[]>` (정규화된 core 와 비교):
hips: hips pelvis hip グルーブ センター(점수 0.9) · spine: spine spine0 abdomen 上半身 · chest: spine1 spine01 chest 上半身2 · upperChest: spine2 spine02 spine3 upperchest 上半身3 ·
neck: neck 首 · head: head 頭 · Shoulder: shoulder clavicle collar 肩 · UpperArm: upperarm uparm arm 腕 · LowerArm: forearm lowerarm elbow ひじ 肘 ·
Hand: hand wrist 手首 · UpperLeg: upleg upperleg thigh 足 · LowerLeg: leg lowerleg calf shin knee ひざ 膝 · Foot: foot ankle 足首 · Toes: toes toe toebase つま先.
`classify(raw): { key: string; score: number } | null` — 정확 일치 1.0(센터 0.9), 아니면 core 가 별칭을 포함(별칭 길이 ≥3 또는 비ASCII) → 0.6, 가장 긴 별칭 우선.
side 있는 키는 side 필수·일치, 중앙 키는 side '' 필수. 손가락은 finger 파싱 결과로 키 생성, 점수 1.0(마디를 숫자로 추정했으면 0.9).
`autoMap(src: Rig, tgt: Rig): MapRow[]` — 각 Rig 에서 키별 최고 점수 본 선택(동점이면 깊이가 얕은 본). 행마다 `confidence = min(점수S, 점수T)`, 한쪽이라도 없으면 0. `enabled = source && target 존재`.
같은 본이 두 키에 뽑히면 점수 높은 키만 유지.

## 4. 리타깃 수학 (`src/retarget.ts`) — 월드 공간 회전 델타 방식
`prepare(src, tgt, rows, opt): Prepared` 와 `bake(src, srcClip, tgt, prep, opt): THREE.AnimationClip`.
**prepare** (두 Rig 모두 rest 로 되돌린 뒤 `root.updateMatrixWorld(true)`; src.root.rotation.y = yawDeg 라디안 적용 상태):
- 사용 행 = enabled 이고 source/target 모두 있는 행. 각 행에 `Qs0 = srcBone 월드 quat`, `Qt0 = tgtBone 월드 quat`, `Ps0/Pt0 = 월드 위치`.
- 방향 보정 `A`(restFix 일 때, 아니면 identity): `CHILD` 표의 자식 키가 양쪽 다 매핑된 경우만
  `ds0 = normalize(srcChildPos0 − Ps0)`, `dt0 = normalize(tgtChildPos0 − Pt0)`, `A = new Quaternion().setFromUnitVectors(dt0, ds0)`; 그 외 identity. hips 는 항상 identity.
  CHILD: spine→chest(없으면 neck), chest→upperChest(없으면 neck), upperChest→neck, neck→head, Shoulder→UpperArm, UpperArm→LowerArm, LowerArm→Hand, Hand→MiddleProximal,
  UpperLeg→LowerLeg, LowerLeg→Foot, Foot→Toes, XProximal→XIntermediate→XDistal (좌우 같은 쪽).
- 사용 행을 **타깃 본 깊이 오름차순** 정렬(부모 먼저).
- 다리 길이 `L = |thigh−shin| + |shin−foot|` (월드, 왼쪽 우선 없으면 오른쪽, 없으면 hips 높이 − 본 최저 y). `ratio = opt.hipsScale ?? Lt / Ls` (Ls≈0 이면 1).
**bake** (프레임 n = 0..N, N = ceil(duration·fps), t = min(n/fps, duration)):
1. src: `srcMixer.setTime(t)` (srcClip action 재생 중), `src.root.updateMatrixWorld(true)`.
2. tgt: 모든 본 rest 로 리셋, `tgt.root.updateMatrixWorld(true)`.
3. 정렬된 각 행: `D = Qs(t) · Qs0⁻¹`; `want = D · A · Qt0`; `bone.parent.updateWorldMatrix(true, false)`; `pw = bone.parent.getWorldQuaternion()`;
   `local = pw⁻¹ · want`; `bone.quaternion.copy(local)`; `bone.updateMatrixWorld(true)`; 이전 프레임 값과 dot<0 이면 부호 반전 후 기록.
4. hips 행(3번에서 회전보다 먼저): `delta = (Ps(t) − Ps0) × ratio`, inPlace 면 `delta.x = delta.z = 0`;
   `bone.position.copy(bone.parent.worldToLocal(Pt0 + delta))` 후 기록.
5. 결과: 행마다 `QuaternionKeyframeTrack(`${bone.uuid}.quaternion`)`, hips 에 `VectorKeyframeTrack(`${bone.uuid}.position`)`. 이름 `${srcClip.name}_retarget`.
끝나면 tgt 본을 rest 로 되돌린다. 이 방식은 축 방향·계층 차이(MMD 下半身, 중간 척추 본 개수 차이)와 스케일(cm/m)을 모두 흡수한다. 매핑 안 된 타깃 본은 rest 유지.
VMD 소스도 같은 경로(합성 스켈레톤 + vmdToClip 클립). 소스가 Rig 의 clips 를 갖고 있으므로 특별 처리 없음.

## 5. 뷰어 (`src/viewer.ts`)
`class Viewer { constructor(canvas); setTarget(rig|null); setSource(rig|null); playClip(clip|null, srcClip|null); setTime(t); time; duration; playing; loop; speed; showSource: boolean; showSkeleton: boolean; onTick?: (t) => void }`
- WebGLRenderer(antialias), 배경 #2a2d33, Hemisphere+Directional 라이트, GridHelper, OrbitControls. 타깃 로드 시 본 월드 위치 범위로 카메라 맞춤.
- 타깃: scene 에 직접. 소스: `sourceHolder`(Group) 안. holder 는 x = −1.2×타깃 폭(최소 1×타깃 키) 만큼 옆에, scale = 타깃 키 / 소스 키(본 y 범위) — 표시 전용이며 균일 스케일이라 리타깃 결과에 영향 없음.
- 소스 SkeletonHelper(색 #4fc3f7)는 showSkeleton, 소스 메시 표시는 showSource. 메시 없는 소스(VMD·Mixamo 본만)는 SkeletonHelper 만.
- 재생: 타깃 mixer 는 결과 클립, 소스 mixer 는 원본 클립을 같은 시간으로 `setTime`. requestAnimationFrame 에서 playing 이면 `t += dt·speed`, loop 면 `t %= duration` 아니면 끝에서 정지.
- bake 중에는 두 mixer 의 `stopAllAction()` 후 다시 `playClip` (bake 는 viewer 의 srcMixer 를 빌려 쓴다: `viewer.withSourceMixer(fn)` 또는 retarget.ts 가 자체 mixer 를 만들어도 된다 — **자체 mixer 를 만드는 쪽으로 구현**, 끝나면 `uncacheRoot`).

## 6. UI (`index.html`, `src/ui.ts`, `src/style.css`) — 어두운 테마, 3열
```
header: 리타깃 툴 | [매핑 저장] [매핑 불러오기] [GLB 내보내기] | #status
aside 왼쪽(300px): ① 모델 드롭존 "모델 파일을 놓거나 클릭 (.glb .gltf .fbx .pmx .pmd)" + 이름/본 수
                   ② 모션 드롭존 "모션 파일을 놓거나 클릭 (.glb .gltf .fbx .vmd)" + 클립 선택 select
                   ③ 옵션: 제자리(in-place) ☐ / 레스트 포즈 방향 보정 ☑ / 소스 방향 회전 select(0 90 180 270) /
                      엉덩이 이동 배율 [자동] number(빈칸=자동, 현재 자동값 placeholder) / 샘플 FPS number(기본 30)
main 가운데: canvas + 아래 재생바 [▶/⏸] [scrub range 0..duration step 1/fps] 시간 "1.23 / 4.00s" 반복☑ 속도 select(0.25 0.5 1 1.5 2) 소스 표시☑ 소스 뼈대☑
aside 오른쪽(420px): 매핑 표 헤더 "본 매핑 — 매칭 n/55" [자동 매핑 다시] [+ 행 추가]
   행: ☑사용 | 라벨 | 소스 select | 타깃 select | 신뢰도 배지
```
- select 첫 옵션 `(없음)`, 나머지는 해당 Rig 의 본 이름(트리 순서, 깊이만큼 `  ` 들여쓰기 표시).
- 신뢰도 배지: ≥0.9 초록 "높음", ≥0.6 노랑 "보통", 그 외 빨강 "낮음"; 한쪽이 (없음)이면 행 배경 붉게(`.unmapped`) + "미매핑". 수동 변경한 행은 confidence 1, 배지 "수동".
- `+ 행 추가`: key `custom${n}`, 라벨 "사용자 지정", custom=true (방향 보정 identity).
- 모든 변경(매핑/옵션/클립) → 200ms 디바운스 후 `prepare`+`bake` 다시 하고 현재 시간 유지하며 재생.
- 드롭: 각 드롭존은 자기 종류로. 캔버스에 놓으면 `.vmd` 포함 → 모션, 모델 없음 → 모델, 그 외 → 모션. 숨김 `<input type=file multiple>` 2개 + 매핑 JSON 용 1개.
- 상태 메시지: `setStatus(msg, 'info'|'warn'|'error')`, 오류는 빨강, 5초 후 info 는 지움.

## 7. 내보내기/저장 (`src/io.ts`)
- `exportGlb(tgt: Rig, clip): Promise<Blob>` — 먼저 viewer 재생 정지 + 타깃 rest 복원, `parseAsync(tgt.root, { binary: true, animations: [clip], onlyVisible: true })`, 끝나면 재생 재개. 파일명 `${모델}_${클립}.glb`.
  타깃 원래 클립은 넣지 않는다(결과 클립 1개). 헬퍼는 tgt.root 밖이므로 포함 안 됨.
- `saveMapping(rows, opt, src, tgt)` → `MappingFile` JSON 다운로드 `${모델}_mapping.json` (들여쓰기 2).
- `loadMapping(file, src, tgt): { rows: MapRow[]; opt: RetargetOptions; missing: string[] }` — version 1 확인, 본 이름이 현재 Rig 에 없으면 null + missing 에 추가 → 경고 `'매핑 파일의 본 n개를 찾지 못했습니다: …'`. 불러온 행은 confidence 1(수동).
- `download(blob, name)`: a[download] + objectURL, 1초 뒤 revoke.

## 8. main.ts 흐름
상태: `model: Rig|null`, `motion: Rig|null`, `clipIndex`, `rows: MapRow[]`, `opt`, `result: AnimationClip|null`.
모델/모션 로드 → 둘 다 있으면 `rows = autoMap()` → 표 렌더 → rebake. 모션 VMD 이면 `buildMmdRig` + `vmdToClip` 로 motion Rig 구성.
새 모델/모션 로드 시 이전 객체 dispose(geometry/material/texture) 및 scene 에서 제거. 버튼(내보내기/저장)은 result 없으면 disabled.

## 9. 엣지 케이스
- 본 없는 파일, 애니메이션 없는 모션 → 오류 메시지, 이전 상태 유지.
- 소스 hips 없음 → 위치 트랙 없이 회전만. 매핑 0개 → `'대응되는 본이 없습니다 — 오른쪽 표에서 직접 지정하세요'`, 결과 null.
- 모델 자체에 클립이 있어도 무시(타깃 rest = 로드 직후 노드 값). 소스 rest 도 로드 직후 값(Mixamo FBX 는 T-포즈).
- 모델·모션이 같은 파일이어도 동작(별도 로드). duration 0 → 1프레임 클립.
- MMD 타깃(PMX)은 IK/물리 없이 FK 로만 보임. MMD 재질은 GLB 내보내기 시 경고가 날 수 있음 → 그대로 진행하고 console.warn.
- 소스/타깃 정면 방향이 다르면 사용자가 "소스 방향 회전"으로 맞춘다(prepare 가 src.root.rotation.y 를 설정 후 측정).
- 다리 길이 0/NaN → ratio 1. NaN quaternion 은 rest 로 대체.

## 10. 수동 검증 체크리스트
1. `cd retarget-tool && npm install && npm run build` 오류 0 (tsc --noEmit 포함), `npm run dev` 화면 표시, `dist/index.html` 을 file:// 로 열어도 동작.
2. Mixamo 캐릭터(.fbx) + 다른 Mixamo 모션(.fbx, Without Skin): 거의 모든 행 "높음", 걷기 재생 정상, 발이 바닥에 붙음.
3. Mixamo 모션 → VRoid/Blender glb(`J_Bip_L_UpperArm`, `upper_arm.L`): 팔/다리 좌우 뒤바뀜 없음, 팔이 몸을 뚫지 않음(방향 보정 끄면 차이 확인).
4. 키 다른 모델(cm FBX ↔ m glb): 엉덩이 이동량이 키에 비례, 제자리 체크 시 X/Z 이동 없음·Y 바운스 유지.
5. .vmd 모션 → glb 모델: 상체/팔 움직임 재생, IK 경고 표시. .pmx 모델 + Mixamo 모션: 일본어 본에 매핑됨(왼쪽 腕 ↔ LeftArm).
6. 행의 select 변경/사용 해제 → 해당 본만 즉시 변화. 미매핑 행 빨강 표시. 매칭 수 갱신.
7. 매핑 저장 → 새로고침 → 같은 파일 로드 → 매핑 불러오기 시 동일 결과; 다른 모델에 불러오면 누락 경고.
8. GLB 내보내기 → 루트 앱(3dto2dsprite) 또는 three.js editor 에 넣으면 `_retarget` 클립이 같은 모습으로 재생.
9. 재생/일시정지, 스크럽, 반복 해제 시 끝에서 정지, 속도 0.25~2, 소스 표시/뼈대 토글 동작.
