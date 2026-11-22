import { Settings } from './types';
import { Rect, composeFrame, opaqueBounds, removeBackground } from './downscale';

interface Img {
  name: string;
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export interface Prepared {
  key: string;
  /** [행(방향)][열(프레임)] RGBA (배경 제거 적용) */
  frames: Uint8ClampedArray[][];
  cw: number;
  ch: number;
  crop: Rect;
  cols: number;
  rows: number;
}

const naturalSort = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const extOf = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

async function toImageData(src: CanvasImageSource, w: number, h: number): Promise<Img['data']> {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0);
  return ctx.getImageData(0, 0, w, h).data;
}

/** 파일 하나를 읽는다. 애니메이션 GIF/WebP 는 가능하면 모든 프레임을 돌려준다. */
async function decodeFile(file: File): Promise<Img[]> {
  const name = file.name.replace(/\.[^.]+$/, '');
  const Decoder = (globalThis as unknown as { ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => {
    tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
    decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>;
    close(): void;
  } }).ImageDecoder;
  const type = file.type || (extOf(file.name) === 'gif' ? 'image/gif' : extOf(file.name) === 'webp' ? 'image/webp' : '');
  if (Decoder && (type === 'image/gif' || type === 'image/webp')) {
    try {
      const dec = new Decoder({ data: await file.arrayBuffer(), type });
      await dec.tracks.ready;
      const n = dec.tracks.selectedTrack?.frameCount ?? 1;
      if (n > 1) {
        const out: Img[] = [];
        for (let i = 0; i < n; i++) {
          const { image } = await dec.decode({ frameIndex: i });
          const w = image.displayWidth, h = image.displayHeight;
          out.push({ name: `${name}_${String(i).padStart(2, '0')}`, w, h, data: await toImageData(image, w, h) });
          image.close();
        }
        dec.close();
        return out;
      }
      dec.close();
    } catch {
      /* 첫 프레임만 읽는 경로로 대체 */
    }
  }
  const bmp = await createImageBitmap(file);
  try {
    return [{ name, w: bmp.width, h: bmp.height, data: await toImageData(bmp, bmp.width, bmp.height) }];
  } finally {
    bmp.close();
  }
}

/**
 * HD 이미지 입력. 이미지 한 장은 (가로 칸 × 세로 칸) 그리드 시트로 잘라 쓰고,
 * 여러 장(또는 애니메이션 GIF)은 파일 이름 순서의 프레임 한 줄로 취급한다.
 * 그리드의 열 = 프레임, 행 = 방향 (3D 모드의 시트 배치와 같다).
 */
export class ImageSource {
  images: Img[] = [];
  version = 0;
  name = '';
  private prepared: Prepared | null = null;

  get loaded(): boolean {
    return this.images.length > 0;
  }

  /** 한 장이면 시트로 자를 수 있다 */
  get sliceable(): boolean {
    return this.images.length === 1;
  }

  async load(files: File[]): Promise<void> {
    const list = files.filter((f) => IMAGE_EXT.includes(extOf(f.name))).sort((a, b) => naturalSort(a.name, b.name));
    if (!list.length) throw new Error('지원하는 이미지(.png .jpg .webp .gif .bmp)가 없습니다.');
    const images: Img[] = [];
    for (const f of list) images.push(...(await decodeFile(f)));
    this.images = images;
    this.name = list.length === 1 ? list[0].name.replace(/\.[^.]+$/, '') : `${list[0].name.replace(/\.[^.]+$/, '')}_etc`;
    this.version++;
    this.prepared = null;
  }

  /** 시트를 칸으로 자르고 배경 제거/여백 자르기를 적용한 결과 (설정이 같으면 캐시) */
  prepare(s: Settings): Prepared | null {
    if (!this.loaded) return null;
    const cols = this.sliceable ? s.imgCols : this.images.length;
    const rows = this.sliceable ? s.imgRows : 1;
    const key = [this.version, cols, rows, s.imgBgRemove, s.imgBgTolerance, s.imgBgEdge, s.imgBgGlobal, s.imgTrim].join('|');
    if (this.prepared?.key === key) return this.prepared;

    let cw: number, ch: number;
    let cells: Uint8ClampedArray[][] = [];
    if (this.sliceable) {
      const img = this.images[0];
      cw = Math.max(1, Math.floor(img.w / cols));
      ch = Math.max(1, Math.floor(img.h / rows));
      for (let r = 0; r < rows; r++) {
        const row: Uint8ClampedArray[] = [];
        for (let c = 0; c < cols; c++) {
          const cell = new Uint8ClampedArray(cw * ch * 4);
          for (let y = 0; y < ch; y++) {
            const so = ((r * ch + y) * img.w + c * cw) * 4;
            cell.set(img.data.subarray(so, so + cw * 4), y * cw * 4);
          }
          row.push(cell);
        }
        cells.push(row);
      }
    } else {
      // 크기가 다른 프레임은 가장 큰 크기에 맞춰 아래 가운데 정렬
      cw = Math.max(...this.images.map((i) => i.w));
      ch = Math.max(...this.images.map((i) => i.h));
      cells = [
        this.images.map((img) => {
          const cell = new Uint8ClampedArray(cw * ch * 4);
          const ox = Math.floor((cw - img.w) / 2), oy = ch - img.h;
          for (let y = 0; y < img.h; y++) {
            cell.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((oy + y) * cw + ox) * 4);
          }
          return cell;
        }),
      ];
    }

    if (s.imgBgRemove) cells = cells.map((row) => row.map((c) => removeBackground(c, cw, ch, s.imgBgTolerance, s.imgBgEdge, s.imgBgGlobal)));

    // 모든 프레임의 불투명 영역을 합친 경계 → 프레임 간 크기/위치가 흔들리지 않는다
    let crop: Rect = { x: 0, y: 0, w: cw, h: ch };
    if (s.imgTrim) {
      let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
      for (const row of cells) {
        for (const c of row) {
          const b = opaqueBounds(c, cw, ch);
          if (!b) continue;
          x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
          x1 = Math.max(x1, b.x + b.w - 1); y1 = Math.max(y1, b.y + b.h - 1);
        }
      }
      if (x1 >= 0) crop = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    }
    this.prepared = { key, frames: cells, cw, ch, crop, cols, rows };
    return this.prepared;
  }

  /** (방향 d, 프레임 i) 를 설정의 SD 크기로 변환한 RGBA */
  render(d: number, i: number, s: Settings): Uint8ClampedArray {
    const p = this.prepare(s);
    const out = new Uint8ClampedArray(s.width * s.height * 4);
    const frame = p?.frames[d]?.[i];
    if (!p || !frame) return out;
    return composeFrame(frame, p.cw, p.crop, {
      width: s.width,
      height: s.height,
      algo: s.imgAlgo,
      fit: s.imgFit,
      align: s.imgAlign,
      margin: s.imgMargin,
    });
  }
}
