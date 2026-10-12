#!/usr/bin/env node
// Draws the LogPane icon into static/icons/*.png. No dependencies: shapes are rendered with
// supersampled signed-distance functions and encoded as PNG by hand with zlib.
//
// Design (a nod to noir comic-cover art): a dark brick wall lit by a rectangular spotlight (the "pane").
// Log lines stand in the light as black silhouettes, and a bold red title bar sits above.
// Monochrome plus one red. The 128 px store icon adds brick texture and spotlight falloff;
// 16 / 32 px keep only the bold shapes (bigger pane, two thick lines).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'icons');

// ---- PNG encoding ----
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

// ---- geometry (16-unit design grid) ----
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function roundedRect(u, v, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const qx = Math.abs(u - cx) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(v - cy) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

const C = {
  wall: hex('#161616'),
  brick: hex('#272727'),
  mortar: hex('#090909'),
  light: hex('#efeee9'),
  lightDim: hex('#b9b8b2'),
  lightMortar: hex('#c4c3bd'),
  ink: hex('#121212'),
  red: hex('#d32f1e'),
};

/** Distance (in design units) to the nearest mortar line of a running-bond brick wall. */
function mortarDistance(u, v) {
  const rowH = 2, brickW = 4;
  const row = Math.floor(v / rowH);
  const dy = Math.min(v - row * rowH, (row + 1) * rowH - v);
  const offset = row % 2 ? brickW / 2 : 0;
  const x = u + offset;
  const dx = Math.min(x - Math.floor(x / brickW) * brickW, Math.ceil(x / brickW) * brickW - x);
  return Math.min(dy, dx);
}

// Small sizes: one big pane and two thick lines. Big sizes: a smaller pane with more wall around it
// and three lines.
const SMALL = { pane: [2.4, 5.6, 13.6, 14.1], title: [2.4, 1.9, 13.6, 4.3], half: 0.9, lines: [[8.0, 3.8, 11.6], [11.6, 3.8, 9.4]] };
const BIG = { pane: [2.0, 5.4, 12.1, 14.6], title: [2.0, 1.8, 14.0, 4.1], half: 0.62, lines: [[7.5, 3.3, 10.4], [9.9, 3.3, 8.4], [12.3, 3.3, 9.6]] };

/** Colour (rgb, alpha) at design coordinates (u, v); `px` is one output (sub)pixel in design units. */
function shade(u, v, px, big, textured) {
  const tile = roundedRect(u, v, 0, 0, 16, 16, 2.6);
  if (tile > 0) return null;
  const mortar = textured ? clamp((0.17 - mortarDistance(u, v)) / px) : 0;

  // Wall.
  let col = textured ? mix(C.brick, C.mortar, mortar) : C.wall;

  const L = big ? BIG : SMALL;

  // Spotlight pane: soft-edged and fading towards the lower right on the big icon, crisp on small ones.
  const [x0, y0, x1, y1] = L.pane;
  const feather = big ? 0.5 : px;
  const pane = roundedRect(u, v, x0, y0, x1, y1, 0.3);
  const lit = clamp(0.5 - pane / feather);
  if (lit > 0) {
    const falloff = textured ? clamp(((u - x0) / (x1 - x0)) * 0.45 + ((v - y0) / (y1 - y0)) * 0.55 - 0.35) : 0;
    let paneCol = mix(C.light, C.lightDim, falloff * 0.8);
    if (textured) paneCol = mix(paneCol, C.lightMortar, mortar * 0.7);
    col = mix(col, paneCol, lit);
  }

  // Log lines as silhouettes in the light.
  for (const [y, lx0, lx1] of L.lines) {
    const d = roundedRect(u, v, lx0, y - L.half, lx1, y + L.half, L.half * 0.45);
    if (d < 0) col = mix(col, C.ink, clamp(-d / px));
  }

  // Red title bar.
  const title = roundedRect(u, v, ...L.title, 0.35);
  if (title < 0) col = mix(col, C.red, clamp(-title / px));

  return { col, alpha: clamp(-tile / px) };
}

function draw(size, pad = 0) {
  const ss = size <= 32 ? 8 : 4;
  const art = size - 2 * pad;
  const px = 16 / art;
  const big = art >= 48;
  const textured = art >= 96;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x - pad + (sx + 0.5) / ss) * px;
          const v = (y - pad + (sy + 0.5) / ss) * px;
          const s = shade(u, v, px / ss, big, textured);
          if (!s) continue;
          const w = s.alpha;
          r += s.col[0] * w;
          g += s.col[1] * w;
          b += s.col[2] * w;
          a += w;
        }
      }
      const i = (y * size + x) * 4;
      const cover = a / (ss * ss);
      // Faint light glow in the store icon's padding, so the dark tile stands out on dark backgrounds.
      const out = pad ? Math.max(0, roundedRect((x - pad + 0.5) * px, (y - pad + 0.5) * px, 0, 0, 16, 16, 2.6) / px) : Infinity;
      const glow = (1 - cover) * 0.13 * clamp(1 - out / 5);
      const alpha = cover + glow;
      if (alpha > 0) {
        const k = cover / alpha;
        buf[i] = Math.round((a ? r / a : 0) * k + 255 * (1 - k));
        buf[i + 1] = Math.round((a ? g / a : 0) * k + 255 * (1 - k));
        buf[i + 2] = Math.round((a ? b / a : 0) * k + 255 * (1 - k));
      }
      buf[i + 3] = Math.round(clamp(alpha) * 255);
    }
  }
  return png(size, buf);
}

mkdirSync(outDir, { recursive: true });
// Toolbar sizes use the full canvas. The 128 store icon follows the Web Store rule:
// 96×96 artwork with 16 px of transparent padding.
for (const size of [16, 32, 48]) writeFileSync(join(outDir, `icon${size}.png`), draw(size));
writeFileSync(join(outDir, 'icon128.png'), draw(128, 16));
console.log(`icons written to ${outDir}`);
