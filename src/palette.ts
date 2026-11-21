export type RGB = [number, number, number];

export const PRESETS: Record<string, { label: string; colors: string[] }> = {
  pico8: {
    label: 'PICO-8 (16색)',
    colors: [
      '000000', '1d2b53', '7e2553', '008751', 'ab5236', '5f574f', 'c2c3c7', 'fff1e8',
      'ff004d', 'ffa300', 'ffec27', '00e436', '29adff', '83769c', 'ff77a8', 'ffccaa',
    ],
  },
  gameboy: {
    label: 'Game Boy (4색)',
    colors: ['0f380f', '306230', '8bac0f', '9bbc0f'],
  },
  sweetie16: {
    label: 'Sweetie 16 (16색)',
    colors: [
      '1a1c2c', '5d275d', 'b13e53', 'ef7d57', 'ffcd75', 'a7f070', '38b764', '257179',
      '29366f', '3b5dc9', '41a6f6', '73eff7', 'f4f4f4', '94b0c2', '566c86', '333c57',
    ],
  },
};

export function hexToRgb(hex: string): RGB | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(c: RGB): string {
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** "#rrggbb" 형태의 색상들을 텍스트에서 모두 추출한다. */
export function parsePalette(text: string): RGB[] {
  const out: RGB[] = [];
  const re = /#?([0-9a-fA-F]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const c = hexToRgb(m[1]);
    if (c) out.push(c);
  }
  return out;
}

export function presetPalette(key: string): RGB[] {
  const p = PRESETS[key];
  return p ? p.colors.map((h) => hexToRgb(h)!) : [];
}

interface Entry {
  r: number;
  g: number;
  b: number;
  n: number;
}

/**
 * 메디안 컷 색상 추출. samples 는 알파가 있는 RGBA 버퍼들이며 알파 0 픽셀은 무시한다.
 */
export function medianCut(samples: Uint8ClampedArray[], maxColors: number): RGB[] {
  // 5비트 버킷 히스토그램 (실제 평균색을 유지)
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>();
  for (const px of samples) {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const key = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3);
      let e = buckets.get(key);
      if (!e) buckets.set(key, (e = { r: 0, g: 0, b: 0, n: 0 }));
      e.r += px[i];
      e.g += px[i + 1];
      e.b += px[i + 2];
      e.n++;
    }
  }
  const entries: Entry[] = [];
  for (const e of buckets.values()) {
    entries.push({ r: e.r / e.n, g: e.g / e.n, b: e.b / e.n, n: e.n });
  }
  if (entries.length === 0) return [];

  const toRgb = (list: Entry[]): RGB => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const e of list) {
      r += e.r * e.n;
      g += e.g * e.n;
      b += e.b * e.n;
      n += e.n;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  };
  if (entries.length <= maxColors) return entries.map((e) => toRgb([e]));

  const range = (list: Entry[]) => {
    let rMin = 255, rMax = 0, gMin = 255, gMax = 0, bMin = 255, bMax = 0;
    for (const e of list) {
      rMin = Math.min(rMin, e.r); rMax = Math.max(rMax, e.r);
      gMin = Math.min(gMin, e.g); gMax = Math.max(gMax, e.g);
      bMin = Math.min(bMin, e.b); bMax = Math.max(bMax, e.b);
    }
    const rr = (rMax - rMin) * 0.8, gr = (gMax - gMin) * 1.0, br = (bMax - bMin) * 0.6;
    const ch: 'r' | 'g' | 'b' = rr >= gr && rr >= br ? 'r' : gr >= br ? 'g' : 'b';
    return { ch, size: Math.max(rr, gr, br) };
  };

  const boxes: Entry[][] = [entries];
  while (boxes.length < maxColors) {
    // 분할 가능한 박스 중 가장 큰(범위 × 픽셀 수^0.5) 박스를 선택
    let best = -1, bestScore = -1;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      const total = boxes[i].reduce((s, e) => s + e.n, 0);
      const score = range(boxes[i]).size * Math.sqrt(total);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) break;
    const box = boxes[best];
    const { ch } = range(box);
    box.sort((a, b) => a[ch] - b[ch]);
    const total = box.reduce((s, e) => s + e.n, 0);
    let acc = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      acc += box[i].n;
      cut = i + 1;
      if (acc >= total / 2) break;
    }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  return boxes.map(toRgb);
}
