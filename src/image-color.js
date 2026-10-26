'use strict';

// Weighted dominant-colour extraction for remote images (bundle banners).
// Riot's bundle display icons are plain 8-bit PNGs, so we decode them with the
// built-in zlib instead of pulling in an image library. The result is a single
// 0xRRGGBB accent colour that represents the artwork, used for Discord
// Components V2 accent bars.

const zlib = require('zlib');

const CACHE = new Map();
const CACHE_TTL = 6 * 60 * 60 * 1000;
const CACHE_MAX = 64;

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

// Returns { width, height, colorType, pixels: Buffer } for an 8-bit,
// non-interlaced PNG. Palette images are expanded to RGBA.
function decodePng(buf) {
  if (!buf || buf.length < 8) throw new Error('not a png');
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i += 1) if (buf[i] !== SIG[i]) throw new Error('not a png');

  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];

  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const start = off + 8;
    const end = Math.min(start + len, buf.length);
    const data = buf.subarray(start, end);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4; // data + CRC
  }

  if (!width || !height) throw new Error('bad ihdr');
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace !== 0) throw new Error('interlaced png unsupported');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  if (!idat.length) throw new Error('no image data');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels; // 8 bits per channel => bytes per pixel
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new Error('truncated image data');

  const out = Buffer.alloc(stride * height);
  let prev = null;
  let src = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const rowStart = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = value; break;
        case 1: v = value + a; break;
        case 2: v = value + b; break;
        case 3: v = value + ((a + b) >> 1); break;
        case 4: v = value + paeth(a, b, c); break;
        default: throw new Error(`bad filter ${filter}`);
      }
      out[rowStart + x] = v & 0xff;
    }
    src += stride;
    prev = out.subarray(rowStart, rowStart + stride);
  }

  // Expand palette / grayscale into a uniform RGBA buffer so the analyser only
  // has to deal with one layout.
  if (colorType === 6) return { width, height, pixels: out };
  const rgba = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;
    if (colorType === 2) {
      r = out[p * 3]; g = out[p * 3 + 1]; b = out[p * 3 + 2];
    } else if (colorType === 0) {
      r = g = b = out[p];
    } else if (colorType === 4) {
      r = g = b = out[p * 2];
      a = out[p * 2 + 1];
    } else if (colorType === 3) {
      const idx = out[p];
      if (palette && idx * 3 + 2 < palette.length) {
        r = palette[idx * 3]; g = palette[idx * 3 + 1]; b = palette[idx * 3 + 2];
      }
      if (trns && idx < trns.length) a = trns[idx];
    }
    rgba[p * 4] = r; rgba[p * 4 + 1] = g; rgba[p * 4 + 2] = b; rgba[p * 4 + 3] = a;
  }
  return { width, height, pixels: rgba };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0; let g = 0; let b = 0;
  if (hp >= 0 && hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

// Weighted dominant colour: bucket the pixels, favour vivid mid-tones, and skip
// transparent / near-black / near-white pixels so the accent bar reads well.
function dominantFromRgba(width, height, pixels) {
  const stepX = Math.max(1, Math.ceil(width / 220));
  const stepY = Math.max(1, Math.ceil(height / 220));
  const bins = new Map();

  for (let y = 0; y < height; y += stepY) {
    const row = y * width * 4;
    for (let x = 0; x < width; x += stepX) {
      const i = row + x * 4;
      const a = pixels[i + 3];
      if (a < 200) continue;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      if (lum < 0.05 || lum > 0.97) continue;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const midWeight = Math.max(0.12, 1 - Math.abs(lum - 0.5) * 1.4);
      const weight = (a / 255) * (0.25 + sat) * midWeight;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let bin = bins.get(key);
      if (!bin) {
        bin = { w: 0, r: 0, g: 0, b: 0 };
        bins.set(key, bin);
      }
      bin.w += weight;
      bin.r += r * weight;
      bin.g += g * weight;
      bin.b += b * weight;
    }
  }

  let best = null;
  for (const bin of bins.values()) {
    if (!best || bin.w > best.w) best = bin;
  }
  if (!best || best.w <= 0) return null;

  let r = Math.round(best.r / best.w);
  let g = Math.round(best.g / best.w);
  let b = Math.round(best.b / best.w);

  // Keep the hue but nudge lightness/saturation into a range where the accent
  // bar stays legible against Discord's dark container.
  const hsl = rgbToHsl(r, g, b);
  let { h, s, l } = hsl;
  if (l < 0.3) l = 0.3;
  if (l > 0.78) l = 0.78;
  if (s > 0.05 && s < 0.3) s = 0.3;
  const adj = hslToRgb(h, s, l);
  r = adj.r; g = adj.g; b = adj.b;
  return (r << 16) | (g << 8) | b;
}

// Fetch + decode + analyse. Returns an integer 0xRRGGBB, or null on any failure
// (callers fall back to their default accent). Results are cached by URL.
async function dominantColor(url, { timeoutMs = 8000 } = {}) {
  if (!url || typeof url !== 'string') return null;
  const now = Date.now();
  const hit = CACHE.get(url);
  if (hit && now - hit.at < CACHE_TTL) return hit.color;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const img = decodePng(buf);
    const color = dominantFromRgba(img.width, img.height, img.pixels);
    if (color == null) return null;
    if (CACHE.size >= CACHE_MAX) {
      const oldest = CACHE.keys().next().value;
      if (oldest !== undefined) CACHE.delete(oldest);
    }
    CACHE.set(url, { color, at: now });
    return color;
  } catch {
    return null;
  }
}

module.exports = { dominantColor, decodePng, dominantFromRgba };
