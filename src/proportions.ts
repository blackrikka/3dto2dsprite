import * as THREE from 'three';

export type Part = 'head' | 'torso' | 'arm' | 'leg';

export interface Proportions {
  head: number;
  torso: number;
  arm: number;
  leg: number;
}

/** MMD 의 IK 컨트롤 본(足ＩＫ 등)은 FK 본이 아니므로 스케일 대상에서 제외한다 */
export const isIkBone = (raw: string) => /[ＩI][ＫK]$/i.test(raw.trim());

/** 좌우/리그 접두어를 떼고 소문자로 정규화 (일본어 본 이름은 유지) */
function normalize(raw: string): string {
  let n = raw
    .replace(/^mixamorig[:_ ]?/i, '')
    .replace(/^bip0?01[ _]?/i, '')
    .replace(/(^|[ _.\-])[LR][ _.\-]/, '$1') // "Bip001 L Thigh" 처럼 가운데 있는 좌우 표기
    .replace(/^(left|right|左|右)[_.\- ]?/i, '')
    .replace(/[_.\- ]?(left|right)$/i, '')
    .replace(/[_.\- ]?[LR]$/, ''); // ArmL, Foot.R, Toe_L (대문자 접미 L/R 만)
  n = n.toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿]/g, '');
  return n;
}

const HEAD_RE = /^(head|頭)$/;
const TORSO_RE = /^(spine\d*|chest\d*|upperchest|upperbody\d*|torso|abdomen|上半身\d*)$/;
const ARM_RE = /^(shoulder|clavicle|collar|upperarm|arm|forearm|fore|lowerarm|elbow|hand|wrist|肩|腕|ひじ|手首)\d*$/;
const LEG_RE = /^(upleg|upperleg|thigh|leg|lowerleg|shin|calf|foot|ankle|toe|toebase|足|ひざ|足首|足先ex|つま先)\d*d?$/;

/** 본 이름으로 부위를 추정한다. 손가락/머리카락처럼 부위에 딸린 본은 부모에서 상속되므로 null. */
export function classifyBone(raw: string): Part | null {
  if (!raw || isIkBone(raw)) return null;
  const n = normalize(raw);
  if (HEAD_RE.test(n)) return 'head';
  if (TORSO_RE.test(n)) return 'torso';
  if (ARM_RE.test(n)) return 'arm';
  if (LEG_RE.test(n)) return 'leg';
  return null;
}

/** 인식된 본 개수 (UI 안내용) */
export function scanBones(root: THREE.Object3D): Record<Part, number> {
  const c: Record<Part, number> = { head: 0, torso: 0, arm: 0, leg: 0 };
  root.traverse((o) => {
    const p = classifyBone(o.name);
    if (p) c[p]++;
  });
  return c;
}

/**
 * 부위별 "누적 배율"을 목표로 각 본의 로컬 스케일을 정한다.
 * 부모의 스케일은 자식에게 상속되므로, 본의 로컬 배율 = 목표 누적 배율 / 부모의 누적 배율.
 * (예: 몸통 0.7, 머리 2.0 이면 머리 본의 로컬 배율은 2.0/0.7)
 * enabled=false 면 원래 스케일로 되돌린다.
 */
export function applyProportions(root: THREE.Object3D, enabled: boolean, p: Proportions): void {
  const cum = new Map<THREE.Object3D, number>();
  root.traverse((o) => {
    if (!o.userData.sdOrigScale) o.userData.sdOrigScale = o.scale.clone();
    const orig = o.userData.sdOrigScale as THREE.Vector3;
    const parentCum = (o.parent && cum.get(o.parent)) ?? 1;
    const part = enabled ? classifyBone(o.name) : null;
    const target = part ? p[part] : parentCum;
    const extra = target / parentCum;
    o.scale.copy(orig).multiplyScalar(extra);
    cum.set(o, target);
  });
}

/** 7등신을 기준(머리 1 : 몸통 2.5 : 다리 3.5)으로 한 대략적인 등신 수 */
export function headCount(p: Proportions): number {
  return (3.5 * p.leg + 2.5 * p.torso + p.head) / p.head;
}

export const SD_PRESETS: { label: string; p: Proportions | null }[] = [
  { label: '원본', p: null },
  { label: '4등신', p: { head: 1.5, torso: 0.85, arm: 0.85, leg: 0.68 } },
  { label: '3등신', p: { head: 1.9, torso: 0.7, arm: 0.7, leg: 0.58 } },
  { label: '2.5등신', p: { head: 2.2, torso: 0.6, arm: 0.62, leg: 0.51 } },
  { label: '2등신', p: { head: 2.6, torso: 0.5, arm: 0.5, leg: 0.39 } },
];
