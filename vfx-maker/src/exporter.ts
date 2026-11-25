import { GIFEncoder } from 'gifenc';
import { zipSync } from 'fflate';
import { RGB, medianCut } from './palette';

export function safeName(s: string): string {
  return s.replace(/[^\w\-가-힣]+/g, '_').replace(/^_+|_+$/g, '') || 'vfx';
}

export function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function toBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG 인코딩 실패'))), type));
}

function frameCanvas(px: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return c;
}

export interface SheetLayout {
  cols: number;
  rows: number;
  cw: number;
  ch: number;
  width: number;
  height: number;
}

/** columns=0 이면 한 줄. 프레임 둘레에 pad(px) 투명 여백. */
export function layout(count: number, w: number, h: number, scale: number, columns: number, pad: number): SheetLayout {
  const cols = columns > 0 ? Math.min(columns, count) : count;
  const rows = Math.ceil(count / cols);
  const cw = (w + 2 * pad) * scale, ch = (h + 2 * pad) * scale;
  return { cols, rows, cw, ch, width: cols * cw, height: rows * ch };
}

export function buildSheet(frames: Uint8ClampedArray[], w: number, h: number, scale: number, columns: number, pad: number): HTMLCanvasElement {
  const L = layout(frames.length, w, h, scale, columns, pad);
  const sheet = document.createElement('canvas');
  sheet.width = L.width;
  sheet.height = L.height;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  frames.forEach((px, i) => {
    const x = (i % L.cols) * L.cw + pad * scale, y = Math.floor(i / L.cols) * L.ch + pad * scale;
    ctx.drawImage(frameCanvas(px, w, h), x, y, w * scale, h * scale);
  });
  return sheet;
}

export interface SheetMeta {
  name: string;
  image: string;
  w: number;
  h: number;
  scale: number;
  count: number;
  fps: number;
  columns: number;
  pad: number;
  loop: boolean;
}

/** Aseprite/TexturePacker "hash" 호환 JSON (Phaser, Godot 임포터 등) */
export function buildJson(m: SheetMeta): string {
  const L = layout(m.count, m.w, m.h, m.scale, m.columns, m.pad);
  const fw = m.w * m.scale, fh = m.h * m.scale, px = m.pad * m.scale;
  const frames: Record<string, unknown> = {};
  for (let i = 0; i < m.count; i++) {
    frames[`${m.name}_${String(i).padStart(2, '0')}`] = {
      frame: { x: (i % L.cols) * L.cw + px, y: Math.floor(i / L.cols) * L.ch + px, w: fw, h: fh },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: fw, h: fh },
      sourceSize: { w: fw, h: fh },
      duration: Math.round(1000 / m.fps),
    };
  }
  return JSON.stringify(
    {
      frames,
      meta: {
        app: 'vfx-maker',
        version: '0.1',
        image: m.image,
        format: 'RGBA8888',
        size: { w: L.width, h: L.height },
        scale: String(m.scale),
        padding: px,
        columns: L.cols,
        fps: m.fps,
        loop: m.loop,
        frameTags: [{ name: m.name, from: 0, to: m.count - 1, direction: 'forward' }],
      },
    },
    null,
    2,
  );
}

export async function buildZip(frames: Uint8ClampedArray[], w: number, h: number, scale: number, base: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < frames.length; i++) {
    const blob = await toBlob(buildSheet([frames[i]], w, h, scale, 0, 0));
    files[`${base}/${base}_${String(i).padStart(2, '0')}.png`] = new Uint8Array(await blob.arrayBuffer());
  }
  return zipSync(files, { level: 0 });
}

/** 투명 GIF (최대 255색 + 투명) */
export function encodeGif(frames: Uint8ClampedArray[], w: number, h: number, scale: number, fps: number, loop: boolean): Uint8Array {
  const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
  const exact = new Map<number, number>();
  for (const px of frames) {
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      const k = key(px[i], px[i + 1], px[i + 2]);
      if (!exact.has(k)) exact.set(k, exact.size);
    }
  }
  let colors: RGB[];
  const lookup = new Map<number, number>();
  if (exact.size <= 255) {
    colors = [...exact.keys()].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255] as RGB);
    colors.forEach((c, i) => lookup.set(key(c[0], c[1], c[2]), i + 1));
  } else {
    colors = medianCut(frames, 255);
  }
  const palette: number[][] = [[0, 0, 0], ...colors];
  const nearest = (r: number, g: number, b: number) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i], d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best + 1;
  };
  const gif = GIFEncoder();
  const ow = w * scale, oh = h * scale;
  for (const px of frames) {
    const idx = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const i = p * 4;
      if (px[i + 3] === 0) continue;
      const k = key(px[i], px[i + 1], px[i + 2]);
      let v = lookup.get(k);
      if (v === undefined) { v = nearest(px[i], px[i + 1], px[i + 2]); lookup.set(k, v); }
      idx[p] = v;
    }
    let out = idx;
    if (scale > 1) {
      out = new Uint8Array(ow * oh);
      for (let y = 0; y < oh; y++) {
        const sy = Math.floor(y / scale) * w;
        for (let x = 0; x < ow; x++) out[y * ow + x] = idx[sy + Math.floor(x / scale)];
      }
    }
    gif.writeFrame(out, ow, oh, { palette, delay: Math.round(1000 / fps), transparent: true, transparentIndex: 0, dispose: 2, repeat: loop ? 0 : -1 });
  }
  gif.finish();
  return gif.bytes();
}
