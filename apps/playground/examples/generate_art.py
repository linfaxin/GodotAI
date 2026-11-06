"""Generate the demo's original pixel art; Python standard library only."""
import base64, json, math, random, struct, zlib
from pathlib import Path

def image(width, height, background=(0, 0, 0, 0)):
    return [[background for _ in range(width)] for _ in range(height)]

def rect(canvas, x, y, width, height, color):
    for py in range(max(0, y), min(len(canvas), y + height)):
        for px in range(max(0, x), min(len(canvas[0]), x + width)):
            canvas[py][px] = color

def png(canvas):
    height, width = len(canvas), len(canvas[0])
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    pixels = b''.join(b'\0' + bytes(channel for pixel in row for channel in pixel) for row in canvas)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels, 9)) + chunk(b'IEND', b'')
    return base64.b64encode(data).decode()

navy = (23, 36, 61, 255)
blue = (82, 157, 208, 255)
cyan = (120, 240, 214, 255)
white = (222, 244, 245, 255)
orange = (255, 184, 92, 255)
rover = image(32, 32)
rect(rover, 5, 23, 22, 3, navy)
for x in (5, 22):
    rect(rover, x, 23, 5, 6, navy); rect(rover, x + 1, 25, 3, 2, blue)
rect(rover, 7, 12, 18, 12, blue);rect(rover, 9, 9, 14, 13, white)
rect(rover, 11, 12, 10, 6, navy);rect(rover, 12, 13, 3, 3, cyan);rect(rover, 17, 13, 3, 3, cyan)
rect(rover, 14, 20, 4, 2, orange);rect(rover, 15, 4, 2, 5, blue);rect(rover, 14, 3, 4, 2, orange)
rect(rover, 4, 15, 3, 6, cyan);rect(rover, 25, 15, 3, 6, cyan)
ship = image(32, 32)
for y in range(5, 25):
    width = max(1, min(10, (y - 4) // 2))
    rect(ship, 16 - width, y, width * 2, 1, blue if y > 17 else white)
rect(ship, 13, 11, 6, 9, navy);rect(ship, 14, 12, 4, 6, cyan)
rect(ship, 7, 24, 6, 3, orange);rect(ship, 19, 24, 6, 3, orange)
rect(ship, 9, 27, 2, 3, (255, 112, 92, 255));rect(ship, 21, 27, 2, 3, (255, 112, 92, 255))
crystal = image(32, 32)
for y in range(3, 28):
    width = min(y - 2, 28 - y, 10)
    for x in range(16 - width, 16 + width):
        crystal[y][x] = cyan if x < 15 else blue
rect(crystal, 12, 9, 2, 9, white);rect(crystal, 11, 25, 10, 3, navy)
banner = image(208, 28, (14, 24, 44, 255))
rng = random.Random(28)
for _ in range(70):
    rect(banner, rng.randrange(208), rng.randrange(28), 1, 1, rng.choice([blue, white, (48, 74, 102, 255)]))
for y in range(28):
    for x in range(136, 188):
        if (x - 162) ** 2 + (y - 19) ** 2 <= 21 ** 2:
            banner[y][x] = (35, 87 + y * 2, 113 + y * 2, 255)
rect(banner, 0, 25, 208, 3, navy)
for y,row in enumerate(rover):
    for x,pixel in enumerate(row):
        if pixel[3] and 0 <= y - 4 < 28: banner[y - 4][x + 32] = pixel
for y,row in enumerate(crystal):
    for x,pixel in enumerate(row):
        if pixel[3] and 0 <= y - 2 < 28: banner[y - 2][x + 104] = pixel
Path(__file__).with_name('art.json').write_text(json.dumps({name: png(canvas) for name, canvas in [('rover',rover),('ship',ship),('crystal',crystal),('outpost',banner)]}, indent=2) + '\n')
