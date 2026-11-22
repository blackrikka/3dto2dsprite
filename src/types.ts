export type PaletteMode = 'auto' | 'pico8' | 'gameboy' | 'sweetie16' | 'custom' | 'none';
export type Shading = 'original' | 'toon';

export type Source = 'model' | 'image';

export interface Settings {
  /** 입력 소스: 3D 모델 / HD 이미지 (저장되지 않고 항상 model 로 시작) */
  source: Source;
  // HD→SD 이미지 변환
  imgCols: number;
  imgRows: number;
  imgAlgo: 'box' | 'mode' | 'nearest';
  imgFit: 'contain' | 'cover' | 'stretch';
  imgAlign: 'center' | 'bottom';
  imgTrim: boolean;
  imgMargin: number;
  imgBgRemove: boolean;
  imgBgTolerance: number;
  imgBgEdge: number;
  imgBgGlobal: boolean;
  // 스프라이트
  width: number;
  height: number;
  directions: number;
  fps: number;
  autoFrames: boolean;
  frameCount: number;
  loop: boolean;
  // 카메라
  pitch: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  inPlace: boolean;
  // 셰이딩/조명
  shading: Shading;
  toonSteps: number;
  lightAzimuth: number;
  lightElevation: number;
  lightIntensity: number;
  ambient: number;
  // 도트 스타일
  paletteMode: PaletteMode;
  colors: number;
  customPalette: string;
  dither: number;
  saturation: number;
  contrast: number;
  brightness: number;
  alphaThreshold: number;
  outline: boolean;
  outlineColor: string;
  // 내보내기
  exportScale: number;
  sheetPadding: number;
}

export const DEFAULTS: Settings = {
  source: 'model',
  imgCols: 1,
  imgRows: 1,
  imgAlgo: 'box',
  imgFit: 'contain',
  imgAlign: 'bottom',
  imgTrim: true,
  imgMargin: 2,
  imgBgRemove: false,
  imgBgTolerance: 12,
  imgBgEdge: 1,
  imgBgGlobal: false,
  width: 64,
  height: 64,
  directions: 8,
  fps: 12,
  autoFrames: true,
  frameCount: 12,
  loop: true,
  pitch: 20,
  zoom: 100,
  offsetX: 0,
  offsetY: 0,
  inPlace: true,
  shading: 'toon',
  toonSteps: 3,
  lightAzimuth: -35,
  lightElevation: 40,
  lightIntensity: 2.4,
  ambient: 0.9,
  paletteMode: 'auto',
  colors: 16,
  customPalette: '#1a1c2c #5d275d #b13e53 #ef7d57 #ffcd75 #f4f4f4',
  dither: 0,
  saturation: 1.1,
  contrast: 1,
  brightness: 0,
  alphaThreshold: 128,
  outline: true,
  outlineColor: '#1a1020',
  exportScale: 1,
  sheetPadding: 0,
};

const COMPASS8 = ['S', 'SE', 'E', 'NE', 'N', 'NW', 'W', 'SW'];

/** 방향 인덱스 → 이름. 0번이 정면(카메라를 바라봄)이고 시계 방향으로 회전한다. */
export function dirName(i: number, n: number): string {
  if (n === 1) return 'S';
  if (n === 4) return COMPASS8[i * 2];
  if (n === 8) return COMPASS8[i];
  return `a${Math.round((360 * i) / n)}`;
}
