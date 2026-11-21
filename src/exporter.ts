import { GIFEncoder } from 'gifenc';
import { RGB, medianCut } from './palette';
import { dirName } from './types';

export type Frames = Uint8ClampedArray[][]; // [direction][frame] RGBA

export function safeName(s: string): string {
  return s.replace(/[^\w\-가-힣]+/g, '_').replace(/^_+|_+$/g, '') || 'sprite';
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

function frameToCanvas(px: Uint8ClampedArray, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
  return c;
}

/** 행 = 방향, 열 = 프레임 인 스프라이트 시트 캔버스 */
export function buildSheet(frames: Frames, w: number, h: number, scale: number): HTMLCanvasElement {
  const rows = frames.length, cols = frames[0]?.length ?? 0;
  const sheet = document.createElement('canvas');
  sheet.width = cols * w * scale;
  sheet.height = rows * h * scale;
  const ctx = sheet.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  frames.forEach((row, d) =>
    row.forEach((px, i) => {
      ctx.drawImage(frameToCanvas(px, w, h), i * w * scale, d * h * scale, w * scale, h * scale);
    }),
  );
  return sheet;
}

export interface SheetMeta {
  name: string;
  clip: string;
  image: string;
  w: number;
  h: number;
  scale: number;
  dirs: number;
  count: number;
  fps: number;
}

/** Aseprite/TexturePacker "hash" 형식과 호환되는 JSON (Phaser, Godot 플러그인, Unity 임포터 등에서 사용 가능) */
export function buildJson(m: SheetMeta): string {
  const fw = m.w * m.scale, fh = m.h * m.scale;
  const frames: Record<string, unknown> = {};
  const tags: unknown[] = [];
  for (let d = 0; d < m.dirs; d++) {
    const dn = dirName(d, m.dirs);
    for (let i = 0; i < m.count; i++) {
      frames[`${m.name}_${dn}_${String(i).padStart(2, '0')}`] = {
        frame: { x: i * fw, y: d * fh, w: fw, h: fh },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: fw, h: fh },
        sourceSize: { w: fw, h: fh },
        duration: Math.round(1000 / m.fps),
      };
    }
    tags.push({ name: `${m.clip}_${dn}`, from: d * m.count, to: d * m.count + m.count - 1, direction: 'forward' });
  }
  return JSON.stringify(
    {
      frames,
      meta: {
        app: '3dto2dsprite',
        version: '0.1',
        image: m.image,
        format: 'RGBA8888',
        size: { w: m.count * fw, h: m.dirs * fh },
        scale: String(m.scale),
        frameTags: tags,
        layout: 'rows=directions, cols=frames',
        directions: Array.from({ length: m.dirs }, (_, d) => dirName(d, m.dirs)),
        fps: m.fps,
      },
    },
    null,
    2,
  );
}

/** 투명 GIF 인코딩 (최대 255색 + 투명). 이미 팔레트 제한이 있으면 색이 그대로 유지된다. */
export function encodeGif(frames: Uint8ClampedArray[], w: number, h: number, scale: number, fps: number): Uint8Array {
  const exact = new Map<number, number>();
  const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
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

  const nearest = (r: number, g: number, b: number): number => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i];
      const d = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
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
      if (px[i + 3] === 0) continue; // 0 = 투명
      const k = key(px[i], px[i + 1], px[i + 2]);
      let v = lookup.get(k);
      if (v === undefined) {
        v = nearest(px[i], px[i + 1], px[i + 2]);
        lookup.set(k, v);
      }
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
    gif.writeFrame(out, ow, oh, {
      palette,
      delay: Math.round(1000 / fps),
      transparent: true,
      transparentIndex: 0,
      dispose: 2,
      repeat: 0,
    });
  }
  gif.finish();
  return gif.bytes();
}
