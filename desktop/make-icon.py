#!/usr/bin/env python3
"""16x16 도트 아이콘(큐브)을 그려 icon/icon.ico (Windows 리소스)와 icon/icon32.rgba (창 아이콘) 를 만든다.
필요: Pillow.  실행: python3 desktop/make-icon.py"""
import io
import os
import struct
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon')
os.makedirs(OUT, exist_ok=True)

OL = (26, 16, 32, 255)          # 외곽선
TOP = (150, 205, 255, 255)
LEFT = (74, 134, 224, 255)
RIGHT = (44, 84, 170, 255)
HI = (255, 255, 255, 255)
ACC = (255, 205, 117, 255)

im = Image.new('RGBA', (16, 16), (0, 0, 0, 0))
d = ImageDraw.Draw(im)
top = [(8, 1), (14, 4), (8, 7), (2, 4)]
left = [(2, 4), (8, 7), (8, 14), (2, 11)]
right = [(8, 7), (14, 4), (14, 11), (8, 14)]
for poly, col in ((top, TOP), (left, LEFT), (right, RIGHT)):
    d.polygon(poly, fill=col, outline=OL)
# "도트로 변환되는" 느낌의 하이라이트/픽셀
for p in [(7, 3), (8, 3), (7, 4)]:
    im.putpixel(p, HI)
for p in [(10, 8), (12, 8), (11, 9), (10, 10), (12, 10)]:
    im.putpixel(p, ACC)

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
