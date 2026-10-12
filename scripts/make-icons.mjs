#!/usr/bin/env node
// Draws the toolbar icon (rounded square with coloured "log lines") into static/icons/*.png.
// No dependencies: PNG is encoded by hand with zlib.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [22, 27, 34];
// [y, x0, x1, colour] in a 16-unit grid
const BARS = [
  [4.0, 3, 13, [88, 166, 255]],
  [7.0, 3, 10, [210, 153, 34]],
  [10.0, 3, 12, [248, 81, 73]],
  [13.0, 3, 8, [139, 148, 158]],
];

function colourAt(u, v) {
  // rounded square, radius 3.2 units
  const r = 3.2;
  const dx = Math.max(r - u, 0, u - (16 - r));
  const dy = Math.max(r - v, 0, v - (16 - r));
  if (dx * dx + dy * dy > r * r) return null;
  for (const [y, x0, x1, c] of BARS) {
    if (Math.abs(v - y) <= 0.95 && u >= x0 && u <= x1) return c;
  }
  return BG;
}

function draw(size) {
  const ss = 4;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colourAt(((x + (sx + 0.5) / ss) / size) * 16, ((y + (sy + 0.5) / ss) / size) * 16);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (a) {
        buf[i] = Math.round(r / a);
        buf[i + 1] = Math.round(g / a);
        buf[i + 2] = Math.round(b / a);
      }
      buf[i + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return png(size, buf);
}

mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) writeFileSync(join(outDir, `icon${size}.png`), draw(size));
console.log(`icons written to ${outDir}`);
