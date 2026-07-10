"""Generate Teams app icons (192x192 color, 32x32 outline) using only stdlib.

Run once to seed `color.png` and `outline.png`. These are minimal placeholder
icons drawn from scratch; replace with branded artwork when available.
"""
import struct
import zlib
from pathlib import Path

HERE = Path(__file__).parent


def write_png(path: Path, width: int, height: int, pixels):
    sig = b"\x89PNG\r\n\x1a\n"

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # row filter byte = None
        for x in range(width):
            r, g, b, a = pixels[y * width + x]
            raw += bytes((r, g, b, a))
    idat = zlib.compress(bytes(raw), 9)
    path.write_bytes(sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


# ---------- color.png: 192x192 brand square with a folder glyph ----------
W, H = 192, 192
BG = (0x00, 0x78, 0xD4, 255)   # #0078D4 — Microsoft blue
WHITE = (255, 255, 255, 255)

color_pixels = []
for y in range(H):
    for x in range(W):
        in_body = 40 <= x <= 152 and 70 <= y <= 150
        in_tab = 40 <= x <= 95 and 55 <= y <= 75
        color_pixels.append(WHITE if (in_body or in_tab) else BG)

write_png(HERE / "color.png", W, H, color_pixels)

# ---------- outline.png: 32x32 transparent + white folder outline ----------
W2, H2 = 32, 32
TRANS = (0, 0, 0, 0)

outline_pixels = []
for y in range(H2):
    for x in range(W2):
        on_body_edge = (
            (8 <= x <= 24 and (y == 12 or y == 25))
            or ((x == 8 or x == 24) and 12 <= y <= 25)
        )
        on_tab_edge = (
            (8 <= x <= 16 and (y == 8 or y == 12))
            or ((x == 8 or x == 16) and 8 <= y <= 12)
        )
        outline_pixels.append(WHITE if (on_body_edge or on_tab_edge) else TRANS)

write_png(HERE / "outline.png", W2, H2, outline_pixels)

print(f"wrote: {HERE / 'color.png'} ({W}x{H})")
print(f"wrote: {HERE / 'outline.png'} ({W2}x{H2})")
