import { Post } from './types';
import { RGB, hexToRgb } from './palette';

/** 8×8 Bayer 행렬 (0..63) */
const BAYER8: number[][] = (() => {
  let m = [[0]];
  for (let n = 1; n < 8; n *= 2) {
    const s = m.length;
    const next: number[][] = Array.from({ length: s * 2 }, () => new Array(s * 2).fill(0));
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + s] = v + 2;
        next[y + s][x] = v + 3;
        next[y + s][x + s] = v + 1;
      }
    }
    m = next;
  }
  return m;
})();

/** 반투명 픽셀을 도트답게 정리: 유지 / 이진화 / 디더(순서 디더로 투명도를 성기게 표현) */
export function applyAlpha(px: Uint8ClampedArray, w: number, h: number, post: Post): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px);
  if (post.alphaMode === 'keep') return out;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = out[i + 3];
      if (a === 0) continue;
      const on =
        post.alphaMode === 'threshold' ? a >= post.alphaThreshold : a / 255 > (BAYER8[y & 7][x & 7] + 0.5) / 64;
      if (on) out[i + 3] = 255;
      else out[i] = out[i + 1] = out[i + 2] = out[i + 3] = 0;
    }
  }
  return out;
}

export function quantize(px: Uint8ClampedArray, palette: RGB[]): void {
  const n = palette.length;
  if (!n) return;
  const pr = new Float32Array(n), pg = new Float32Array(n), pb = new Float32Array(n);
  palette.forEach((c, i) => { pr[i] = c[0]; pg[i] = c[1]; pb[i] = c[2]; });
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    let best = 0, bd = Infinity;
    for (let k = 0; k < n; k++) {
      const dr = r - pr[k], dg = g - pg[k], db = b - pb[k];
      const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11;
      if (d < bd) { bd = d; best = k; }
    }
    px[i] = pr[best]; px[i + 1] = pg[best]; px[i + 2] = pb[best];
  }
}

export function outline(px: Uint8ClampedArray, w: number, h: number, color: RGB): void {
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = px[i * 4 + 3] ? 1 : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (solid[p]) continue;
      if ((x > 0 && solid[p - 1]) || (x < w - 1 && solid[p + 1]) || (y > 0 && solid[p - w]) || (y < h - 1 && solid[p + w])) {
        const i = p * 4;
        px[i] = color[0]; px[i + 1] = color[1]; px[i + 2] = color[2]; px[i + 3] = 255;
      }
    }
  }
}

export function finalize(raw: Uint8ClampedArray, w: number, h: number, post: Post, palette: RGB[] | null): Uint8ClampedArray {
  const px = applyAlpha(raw, w, h, post);
  if (palette && palette.length) quantize(px, palette);
  if (post.outline) outline(px, w, h, hexToRgb(post.outlineColor) ?? [0, 0, 0]);
  return px;
}
