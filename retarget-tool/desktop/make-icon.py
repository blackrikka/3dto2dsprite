#!/usr/bin/env python3
"""16x16 도트 아이콘(뼈대 모양: 리타깃)을 그려 icon/icon.ico (Windows 리소스)와 icon/icon32.rgba (창 아이콘) 를 만든다.
필요: Pillow.  실행: python3 retarget-tool/desktop/make-icon.py"""
import io
import os
import struct
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon')
os.makedirs(OUT, exist_ok=True)

OL = (10, 28, 48, 255)           # 외곽선 (짙은 남청)
CORE = (224, 250, 255, 255)      # 밝은 하이라이트
MID = (79, 195, 247, 255)        # 본체 (하늘색)
RAY = (21, 115, 200, 255)        # 그늘 (진한 파랑)

im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
lit = {}
# 뼈 모양: 가운데 막대 + 양 끝의 둥근 마디 4개
KNOBS = [(-4.0, -3.0), (4.0, -3.0), (-4.0, 3.0), (4.0, 3.0)]
for y in range(16):
    for x in range(16):
        dx, dy = x + 0.5 - 8, y + 0.5 - 8
        if abs(dy) < 1.0 and abs(dx) <= 4.5:            # 막대
            lit[(x, y)] = RAY if abs(dy) > 0.5 else MID
        for kx, ky in KNOBS:                              # 마디
            d = ((dx - kx) ** 2 + (dy - ky) ** 2) ** 0.5
            if d <= 2.6:
                lit[(x, y)] = CORE if d <= 1.2 else MID if d <= 2.0 else RAY
for (x, y) in list(lit):
    for ox, oy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        q = (x + ox, y + oy)
        if q not in lit and 0 <= q[0] < 16 and 0 <= q[1] < 16:
            im.putpixel(q, OL)
for (x, y), c in lit.items():
    im.putpixel((x, y), c)

def scaled(n):
    return im.resize((n, n), Image.NEAREST)

sizes = [16, 32, 48, 64, 128, 256]
blobs = []
for n in sizes:
    b = io.BytesIO()
    scaled(n).save(b, format='PNG')
    blobs.append(b.getvalue())

ico = struct.pack('<HHH', 0, 1, len(sizes))
off = 6 + 16 * len(sizes)
for n, blob in zip(sizes, blobs):
    ico += struct.pack('<BBBBHHII', n % 256, n % 256, 0, 0, 1, 32, len(blob), off)
    off += len(blob)
ico += b''.join(blobs)
open(os.path.join(OUT, 'icon.ico'), 'wb').write(ico)

# NSIS(설치 프로그램 아이콘)는 PNG 압축 ICO 를 못 읽으므로 BMP(DIB) 형식의 ICO 도 만든다
def dib(n):
    img = scaled(n)
    px = img.load()
    header = struct.pack('<IiiHHIIiiII', 40, n, n * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    pixels = b''
    for y in range(n - 1, -1, -1):          # 아래→위
        for x in range(n):
            r, g, b, a = px[x, y]
            pixels += struct.pack('<BBBB', b, g, r, a)
    mask_row = ((n + 31) // 32) * 4
    return header + pixels + bytes(mask_row * n)  # AND 마스크는 0 (알파 사용)

legacy_sizes = [16, 32, 48]
dibs = [dib(n) for n in legacy_sizes]
ico2 = struct.pack('<HHH', 0, 1, len(legacy_sizes))
off = 6 + 16 * len(legacy_sizes)
for n, blob in zip(legacy_sizes, dibs):
    ico2 += struct.pack('<BBBBHHII', n, n, 0, 0, 1, 32, len(blob), off)
    off += len(blob)
ico2 += b''.join(dibs)
open(os.path.join(OUT, 'icon_legacy.ico'), 'wb').write(ico2)
open(os.path.join(OUT, 'icon32.rgba'), 'wb').write(scaled(32).tobytes())
scaled(256).save(os.path.join(OUT, 'icon256.png'))
print('ok', len(ico))
