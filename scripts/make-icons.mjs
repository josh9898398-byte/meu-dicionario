#!/usr/bin/env node
/**
 * Generates the PWA icon set with zero dependencies.
 *
 *   npm run icons
 *
 * Implements a tiny PNG encoder (zlib + CRC32) and a 4x supersampled
 * rasteriser, so icons can be regenerated on any machine with Node — no
 * ImageMagick, no sharp, no network.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const OUT = join(ROOT, 'assets', 'icons');
const SS = 4; // supersampling factor

/* ------------------------------------------------------------ png encoder */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* -------------------------------------------------------------- rasteriser */

function createCanvas(size) {
  return { size, data: new Float32Array(size * size * 4) };
}

function blend(canvas, x, y, color, alpha = 1) {
  if (alpha <= 0 || x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return;
  const i = (y * canvas.size + x) * 4;
  const a = Math.min(1, alpha);
  const src = [color[0], color[1], color[2]];
  for (let c = 0; c < 3; c += 1) {
    canvas.data[i + c] = canvas.data[i + c] * (1 - a) + src[c] * a;
  }
  canvas.data[i + 3] = Math.min(1, canvas.data[i + 3] + a);
}

function fillRoundedRect(canvas, x0, y0, w, h, radius, color, alpha = 1) {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y += 1) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x += 1) {
      const dx = Math.max(x0 + radius - x, 0, x - (x0 + w - radius - 1));
      const dy = Math.max(y0 + radius - y, 0, y - (y0 + h - radius - 1));
      if (dx * dx + dy * dy > radius * radius) continue;
      blend(canvas, x, y, color, alpha);
    }
  }
}

function gradientBackground(canvas, topColor, bottomColor, radius) {
  const { size } = canvas;
  for (let y = 0; y < size; y += 1) {
    const t = y / (size - 1);
    const color = [
      topColor[0] + (bottomColor[0] - topColor[0]) * t,
      topColor[1] + (bottomColor[1] - topColor[1]) * t,
      topColor[2] + (bottomColor[2] - topColor[2]) * t
    ];
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(radius - x, 0, x - (size - radius - 1));
      const dy = Math.max(radius - y, 0, y - (size - radius - 1));
      if (dx * dx + dy * dy > radius * radius) continue;
      blend(canvas, x, y, color, 1);
    }
  }
}

function fillCircle(canvas, cx, cy, r, color, alpha = 1) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r * r) continue;
      blend(canvas, x, y, color, alpha);
    }
  }
}

function fillPolygon(canvas, points, color, alpha = 1) {
  const ys = points.map((p) => p[1]);
  const minY = Math.floor(Math.min(...ys));
  const maxY = Math.ceil(Math.max(...ys));
  for (let y = minY; y <= maxY; y += 1) {
    const crosses = [];
    for (let i = 0; i < points.length; i += 1) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        crosses.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crosses.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crosses.length; i += 2) {
      for (let x = Math.floor(crosses[i]); x <= Math.ceil(crosses[i + 1]); x += 1) {
        if (x < crosses[i] - 1 || x > crosses[i + 1] + 1) continue;
        blend(canvas, x, y, color, alpha);
      }
    }
  }
}

function downsample(big, factor) {
  const size = big.size / factor;
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const i = ((y * factor + dy) * big.size + (x * factor + dx)) * 4;
          r += big.data[i]; g += big.data[i + 1]; b += big.data[i + 2]; a += big.data[i + 3];
        }
      }
      const n = factor * factor;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round((a / n) * 255);
    }
  }
  return { size, buffer: out };
}

/* ------------------------------------------------------------------ drawing */

/**
 * The mark: a bookmark/speech-tab with a "P" (Português) cut out and a small
 * waveform to hint at pronunciation. Drawn with primitives so it scales
 * crisply at every size.
 */
function drawIcon(size, { maskable = false } = {}) {
  const S = size * SS;
  const canvas = createCanvas(S);
  const pad = maskable ? S * 0.17 : 0;
  const radius = maskable ? S * 0.24 : S * 0.235;

  gradientBackground(canvas, [0x11, 0x8a, 0x7e], [0x0a, 0x53, 0x4f], radius);

  // white bookmark tab with a notch at the bottom
  const tabW = maskable ? S - pad * 2 : S * 0.60;
  const tabH = maskable ? S - pad * 2 : S * 0.74;
  const tabX = (S - tabW) / 2;
  const tabY = (S - tabH) / 2;
  const notch = tabH * 0.17;
  const left = tabX;
  const right = tabX + tabW;
  const bottom = tabY + tabH;
  const midX = (left + right) / 2;
  fillPolygon(canvas, [
    [left + tabW * 0.10, tabY],
    [right - tabW * 0.10, tabY],
    [right - tabW * 0.10, bottom - notch],
    [midX, bottom - notch * 1.75],
    [left + tabW * 0.10, bottom - notch]
  ], [255, 255, 255], 1);

  // "P" for Português, drawn inside the tab
  const ink = [0x0c, 0x5c, 0x57];
  const stemW = tabW * 0.075;
  const stemX = midX - tabW * 0.185;
  const stemTop = tabY + tabH * 0.17;
  const stemBottom = tabY + tabH * 0.49;
  const bowlR = tabW * 0.125;
  const bowlCy = stemTop + bowlR * 0.95;
  fillRoundedRect(canvas, stemX, stemTop, stemW, stemBottom - stemTop, stemW * 0.3, ink, 1);
  fillCircle(canvas, stemX + stemW / 2 + bowlR * 0.82, bowlCy, bowlR, ink, 1);
  fillCircle(canvas, stemX + stemW / 2 + bowlR * 0.82, bowlCy, bowlR * 0.46, [255, 255, 255], 1);

  // pronunciation waveform under the letter
  const bars = 5;
  const barW = tabW * 0.058;
  const gap = barW * 0.95;
  const totalW = bars * barW + (bars - 1) * gap;
  const startX = midX - totalW / 2;
  const baseY = tabY + tabH * 0.58;
  const heights = [0.06, 0.11, 0.16, 0.10, 0.06];
  for (let i = 0; i < bars; i += 1) {
    const h = tabH * heights[i];
    fillRoundedRect(canvas, startX + i * (barW + gap), baseY - h / 2, barW, h, barW / 2, ink, 1);
  }

  return downsample(canvas, SS);
}

function svgFavicon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#118a7e"/>
      <stop offset="1" stop-color="#0a534f"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="15" fill="url(#g)"/>
  <path d="M18 8h28a2 2 0 0 1 2 2v40l-16-9-16 9V10a2 2 0 0 1 2-2z" fill="#fff"/>
  <circle cx="32" cy="24" r="6.4" fill="#0c5c57"/>
  <rect x="30.6" y="14" width="2.8" height="20" rx="1.4" fill="#0c5c57"/>
  <g fill="#0c5c57">
    <rect x="24.4" y="39" width="2.6" height="6" rx="1.3"/>
    <rect x="28.4" y="36" width="2.6" height="12" rx="1.3"/>
    <rect x="32.4" y="33" width="2.6" height="18" rx="1.3"/>
    <rect x="36.4" y="36" width="2.6" height="12" rx="1.3"/>
    <rect x="40.4" y="39" width="2.6" height="6" rx="1.3"/>
  </g>
</svg>
`;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const targets = [
    { file: 'icon-192.png', size: 192 },
    { file: 'icon-512.png', size: 512 },
    { file: 'apple-touch-icon.png', size: 180, maskable: true },
    { file: 'icon-maskable-512.png', size: 512, maskable: true }
  ];
  for (const target of targets) {
    const { size, buffer } = drawIcon(target.size, { maskable: target.maskable });
    await writeFile(join(OUT, target.file), encodePng(size, size, buffer));
    console.log(`· ${target.file} (${size}×${size})`);
  }
  await writeFile(join(OUT, 'favicon.svg'), svgFavicon(), 'utf8');
  console.log('· favicon.svg');
  console.log('\nicons written to assets/icons\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
