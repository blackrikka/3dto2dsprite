import type * as THREE from 'three';

export type RigKind = 'model' | 'motion';

/** 로드된 스켈레톤(모델 또는 모션) */
export interface Rig {
  kind: RigKind;
  name: string;
  root: THREE.Object3D;
  /** root.traverse 순서 (부모가 먼저) */
  bones: THREE.Bone[];
  /** 이름 → 본 (이름 중복이면 첫 번째만) */
  byName: Map<string, THREE.Bone>;
  clips: THREE.AnimationClip[];
  isMmd: boolean;
  hasMesh: boolean;
  /** 로드 직후의 local 값 (레스트 포즈) */
  rest: Map<THREE.Bone, { q: THREE.Quaternion; p: THREE.Vector3 }>;
}

/** 매핑 표의 한 행 (캐노니컬 키 또는 사용자 지정 행) */
export interface MapRow {
  key: string;
  label: string;
  /** 소스(모션) 본 이름, 없으면 null */
  source: string | null;
  /** 타깃(모델) 본 이름, 없으면 null */
  target: string | null;
  enabled: boolean;
  /** 0~1. 수동 변경/불러온 행은 1 */
  confidence: number;
  custom?: boolean;
  /** 사용자가 직접 지정했거나 파일에서 불러온 행 (구현 추가 필드: 배지 "수동" 표시용) */
  manual?: boolean;
}

export interface RetargetOptions {
  fps: number;
  inPlace: boolean;
  restFix: boolean;
  yawDeg: 0 | 90 | 180 | 270;
  /** null = 자동 (다리 길이 비) */
  hipsScale: number | null;
}

export interface MappingFile {
  version: 1;
  source: string;
  target: string;
  rows: { key: string; source: string | null; target: string | null; enabled: boolean }[];
  options: RetargetOptions;
}

/** three-stdlib MMDLoader.loadVMD 가 돌려주는 VMD 데이터 (오른손 좌표계로 변환됨, 30fps) */
export interface VmdMotion {
  motions: {
    boneName: string;
    frameNum: number;
    position: number[];
    /** x, y, z, w */
    rotation: number[];
  }[];
}
