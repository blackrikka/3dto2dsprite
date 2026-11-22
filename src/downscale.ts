export type Algo = 'box' | 'mode' | 'nearest';
export type Fit = 'contain' | 'cover' | 'stretch';
export type Align = 'center' | 'bottom';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 가장자리와 이어진, 모서리(좌상단) 색과 비슷한 영역을 투명으로 만든다.
 * tolerance: 0~100 (%). 색 거리(RGB 유클리드)의 최대값(≈441) 대비 비율.
 * global: true 면 가장자리와 이어지지 않은 내부 조각(목 틈, 팔 사이 등)도 일치하면 모두 제거한다.
 * edge: 제거 후 가장자리를 몇 픽셀 더 깎을지. 안티에일리어싱으로 배경색이 섞인 경계 픽셀(후광)을
 *       더 느슨한 기준(허용 오차 ×2.5)으로 한 겹씩 벗겨 낸다.
 */
export function removeBackground(
  src: Uint8ClampedArray,
  w: number,
  h: number,
  tolerance: number,
  edge = 0,
  global = false,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src);
  if (src[3] === 0) return out; // 이미 투명 배경
  const kr = src[0], kg = src[1], kb = src[2];
  const limit = ((tolerance / 100) * 441.67) ** 2;
  const match = (p: number) => {
    const i = p * 4;
    if (src[i + 3] === 0) return false;
    const dr = src[i] - kr, dg = src[i + 1] - kg, db = src[i + 2] - kb;
    return dr * dr + dg * dg + db * db <= limit;
  };
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (p: number) => {
    if (!seen[p] && match(p)) {
      seen[p] = 1;
      stack[sp++] = p;
    }
  };
  if (global) {
    for (let p = 0; p < w * h; p++) push(p);
  } else {
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  }
  while (sp > 0) {
    const p = stack[--sp];
    out[p * 4 + 3] = 0;
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }

  // 가장자리 정리: 투명과 맞닿은 불투명 픽셀 중 배경색에 (느슨하게) 가까운 것을 한 겹씩 제거
  const loose = ((Math.min(100, tolerance * 2.5) / 100) * 441.67) ** 2;
  for (let pass = 0; pass < edge; pass++) {
    const peel: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x, i = p * 4;
        if (out[i + 3] === 0) continue;
        const touches =
          (x > 0 && out[(p - 1) * 4 + 3] === 0) ||
          (x < w - 1 && out[(p + 1) * 4 + 3] === 0) ||
          (y > 0 && out[(p - w) * 4 + 3] === 0) ||
          (y < h - 1 && out[(p + w) * 4 + 3] === 0);
        if (!touches) continue;
        const dr = out[i] - kr, dg = out[i + 1] - kg, db = out[i + 2] - kb;
        if (dr * dr + dg * dg + db * db <= loose) peel.push(i + 3);
      }
    }
    if (!peel.length) break;
    for (const a of peel) out[a] = 0;
  }
  return out;
}

/** 알파가 threshold 이상인 픽셀의 경계 사각형. 없으면 null */
export function opaqueBounds(px: Uint8ClampedArray, w: number, h: number, threshold = 8): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** src 의 rect 영역을 dw×dh 로 줄인다 (알파 가중 평균 / 최빈색 / 최근접). */
export function downscale(
  src: Uint8ClampedArray,
  sw: number,
  rect: Rect,
  dw: number,
  dh: number,
  algo: Algo,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sums = algo === 'mode' ? new Float32Array(4096 * 4) : null; // r,g,b,count 버킷
  const touched: number[] = [];
  for (let oy = 0; oy < dh; oy++) {
    const y0 = rect.y + Math.floor((oy * rect.h) / dh);
    const y1 = Math.max(y0 + 1, rect.y + Math.floor(((oy + 1) * rect.h) / dh));
    for (let ox = 0; ox < dw; ox++) {
      const x0 = rect.x + Math.floor((ox * rect.w) / dw);
      const x1 = Math.max(x0 + 1, rect.x + Math.floor(((ox + 1) * rect.w) / dw));
      const o = (oy * dw + ox) * 4;

      if (algo === 'nearest') {
        const sx = Math.min(rect.x + rect.w - 1, rect.x + Math.floor(((ox + 0.5) * rect.w) / dw));
        const sy = Math.min(rect.y + rect.h - 1, rect.y + Math.floor(((oy + 0.5) * rect.h) / dh));
        const i = (sy * sw + sx) * 4;
        out[o] = src[i]; out[o + 1] = src[i + 1]; out[o + 2] = src[i + 2]; out[o + 3] = src[i + 3];
        continue;
      }

      let n = 0, opaque = 0, aSum = 0, rSum = 0, gSum = 0, bSum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          const a = src[i + 3];
          n++;
          aSum += a;
          if (algo === 'box') {
            rSum += src[i] * a; gSum += src[i + 1] * a; bSum += src[i + 2] * a;
          } else if (a >= 128) {
            opaque++;
            const k = ((src[i] >> 4) << 8) | ((src[i + 1] >> 4) << 4) | (src[i + 2] >> 4);
            const b = k * 4;
            if (sums![b + 3] === 0) touched.push(k);
            sums![b] += src[i]; sums![b + 1] += src[i + 1]; sums![b + 2] += src[i + 2]; sums![b + 3]++;
          }
        }
      }
      if (algo === 'box') {
        if (aSum > 0) {
          out[o] = rSum / aSum; out[o + 1] = gSum / aSum; out[o + 2] = bSum / aSum;
          out[o + 3] = aSum / n;
        }
      } else {
        let best = -1, bestN = 0;
        for (const k of touched) {
          if (sums![k * 4 + 3] > bestN) { bestN = sums![k * 4 + 3]; best = k; }
        }
        if (best >= 0 && opaque * 2 >= n) {
          const b = best * 4;
          out[o] = sums![b] / bestN; out[o + 1] = sums![b + 1] / bestN; out[o + 2] = sums![b + 2] / bestN;
          out[o + 3] = 255;
        }
        for (const k of touched) sums!.fill(0, k * 4, k * 4 + 4);
        touched.length = 0;
      }
    }
  }
  return out;
}

export interface ComposeOptions {
  width: number;
  height: number;
  algo: Algo;
  fit: Fit;
  align: Align;
  margin: number;
}

/** crop 영역을 width×height 캔버스에 맞춰 축소·배치한다. */
export function composeFrame(
  src: Uint8ClampedArray,
  sw: number,
  crop: Rect,
  o: ComposeOptions,
): Uint8ClampedArray {
  const W = o.width, H = o.height;
  const areaW = Math.max(1, W - 2 * o.margin), areaH = Math.max(1, H - 2 * o.margin);
  let sx = areaW / crop.w, sy = areaH / crop.h;
  if (o.fit === 'contain') sx = sy = Math.min(sx, sy);
  else if (o.fit === 'cover') sx = sy = Math.max(sx, sy);
  const dw = Math.max(1, Math.round(crop.w * sx)), dh = Math.max(1, Math.round(crop.h * sy));
  const small = downscale(src, sw, crop, dw, dh, o.algo);

  const ox = o.margin + Math.floor((areaW - dw) / 2);
  const oy = o.align === 'bottom' ? o.margin + (areaH - dh) : o.margin + Math.floor((areaH - dh) / 2);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < dh; y++) {
    const ty = oy + y;
    if (ty < 0 || ty >= H) continue;
    for (let x = 0; x < dw; x++) {
      const tx = ox + x;
      if (tx < 0 || tx >= W) continue;
      const i = (y * dw + x) * 4, j = (ty * W + tx) * 4;
      out[j] = small[i]; out[j + 1] = small[i + 1]; out[j + 2] = small[i + 2]; out[j + 3] = small[i + 3];
    }
  }
  return out;
}
