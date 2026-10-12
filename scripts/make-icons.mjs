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

/**
 * `pad` px of transparent margin on each side. The Web Store asks for 96×96 artwork inside the 128×128
 * store icon. That margin gets a faint light glow so the dark tile still stands out on dark backgrounds.
 */
function draw(size, pad = 0) {
  const ss = 4;
  const art = size - 2 * pad;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = colourAt(((x - pad + (sx + 0.5) / ss) / art) * 16, ((y - pad + (sy + 0.5) / ss) / art) * 16);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a++;
          }
        }
      }
      const i = (y * size + x) * 4;
      const cover = a / (ss * ss);
      // glow: distance outside the rounded tile, in px
      const glow = pad ? Math.max(0, 0.22 * (1 - outsideDistance(x + 0.5 - pad, y + 0.5 - pad, art) / 6)) * (1 - cover) : 0;
      const alpha = cover + glow;
      if (alpha > 0) {
        buf[i] = Math.round((r / Math.max(a, 1)) * (cover / alpha) + 255 * (glow / alpha));
        buf[i + 1] = Math.round((g / Math.max(a, 1)) * (cover / alpha) + 255 * (glow / alpha));
        buf[i + 2] = Math.round((b / Math.max(a, 1)) * (cover / alpha) + 255 * (glow / alpha));
      }
      buf[i + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return png(size, buf);
}

/** Distance in px from the rounded tile (side `art`, radius 3.2/16 of it); 0 inside. */
function outsideDistance(px, py, art) {
  const r = (3.2 / 16) * art;
  const dx = Math.max(r - px, 0, px - (art - r));
  const dy = Math.max(r - py, 0, py - (art - r));
  return Math.max(0, Math.hypot(dx, dy) - r);
}

mkdirSync(outDir, { recursive: true });
// Toolbar sizes use the full canvas; the 128 store icon follows the 96 + 2×16 padding rule.
for (const size of [16, 32, 48]) writeFileSync(join(outDir, `icon${size}.png`), draw(size));
writeFileSync(join(outDir, 'icon128.png'), draw(128, 16));
console.log(`icons written to ${outDir}`);
