import { RGB, hexToRgb } from './palette';
import { Settings } from './types';

type PostSettings = Pick<
  Settings,
  'alphaThreshold' | 'saturation' | 'contrast' | 'brightness' | 'dither' | 'outline' | 'outlineColor'
>;

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** 알파 이진화 + 채도/대비/밝기 보정. 팔레트 추출과 최종 처리에 공통으로 쓰인다. */
export function prepare(raw: Uint8ClampedArray, s: PostSettings): Uint8ClampedArray {
  const out = new Uint8ClampedArray(raw.length);
  const thr = s.alphaThreshold;
  const con = s.contrast;
  const br = s.brightness * 255;
  const sat = s.saturation;
  for (let i = 0; i < raw.length; i += 4) {
    if (raw[i + 3] < thr) continue; // 투명 (0,0,0,0)
    let r = (raw[i] - 128) * con + 128 + br;
    let g = (raw[i + 1] - 128) * con + 128 + br;
    let b = (raw[i + 2] - 128) * con + 128 + br;
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    r = l + (r - l) * sat;
    g = l + (g - l) * sat;
    b = l + (b - l) * sat;
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
  }
  return out;
}

function quantize(px: Uint8ClampedArray, w: number, h: number, palette: RGB[], dither: number): void {
  const n = palette.length;
  const pr = new Float32Array(n), pg = new Float32Array(n), pb = new Float32Array(n);
  palette.forEach((c, i) => { pr[i] = c[0]; pg[i] = c[1]; pb[i] = c[2]; });
  const amp = (dither * 255) / Math.max(2, Math.cbrt(n));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (px[i + 3] === 0) continue;
      const bias = dither > 0 ? (BAYER4[y & 3][x & 3] / 16 - 0.5 + 1 / 32) * amp : 0;
      const r = px[i] + bias, g = px[i + 1] + bias, b = px[i + 2] + bias;
      let best = 0, bestD = Infinity;
      for (let k = 0; k < n; k++) {
        const dr = r - pr[k], dg = g - pg[k], db = b - pb[k];
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
        if (d < bestD) { bestD = d; best = k; }
      }
      px[i] = pr[best];
      px[i + 1] = pg[best];
      px[i + 2] = pb[best];
    }
  }
}

/** 불투명 픽셀과 4방향으로 맞닿은 투명 픽셀을 외곽선 색으로 채운다. */
function outline(px: Uint8ClampedArray, w: number, h: number, color: RGB): void {
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = px[i * 4 + 3] ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (solid[p]) continue;
      if (
        (x > 0 && solid[p - 1]) ||
        (x < w - 1 && solid[p + 1]) ||
        (y > 0 && solid[p - w]) ||
        (y < h - 1 && solid[p + w])
      ) {
        const i = p * 4;
        px[i] = color[0];
        px[i + 1] = color[1];
        px[i + 2] = color[2];
        px[i + 3] = 255;
      }
    }
  }
}

export function processFrame(
  raw: Uint8ClampedArray,
  w: number,
  h: number,
  s: PostSettings,
  palette: RGB[] | null,
): Uint8ClampedArray {
  const px = prepare(raw, s);
  if (palette && palette.length) quantize(px, w, h, palette, s.dither);
  if (s.outline) outline(px, w, h, hexToRgb(s.outlineColor) ?? [0, 0, 0]);
  return px;
}
