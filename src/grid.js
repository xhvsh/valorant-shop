'use strict';

const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');
const { GifReader } = require('omggif');
const { GIFEncoder, quantize } = require('gifenc');
const { CURRENCY, CURRENCY_LABEL, tierIcon, resolve: resolveItem, load: loadItems, normalizeName } = require('./items');

const FONT = path.join(__dirname, '..', 'assets', 'DejaVuSans.ttf');
// Anton: a bold condensed display face that stands in for VALORANT's DIN Next
// on the rank card. Bundled because the render runs with system fonts off.
const FONT_DISPLAY = path.join(__dirname, '..', 'assets', 'Anton-Regular.ttf');
// Monospace for the RR readout (e.g. "43/100").
const FONT_MONO = path.join(__dirname, '..', 'assets', 'RankMono.ttf');
const CURRENCY_ICON_URLS = {
  vp: `https://media.valorant-api.com/currencies/${CURRENCY.vp}/displayicon.png`,
  kc: `https://media.valorant-api.com/currencies/${CURRENCY.kc}/displayicon.png`,
};
const CELL_W = 560;
const CELL_H = 320;
const ICON_W = 510;
const ICON_H = 170;
const GAP = 18;
const PAD = 0;
const EMOJI_IDS = {
  vp: '1557460817773989991',
  kc: '1557461012507263026',
  rp: '1557460915287367791',
};

// Bump this whenever grid rendering changes so CDN/edge caches are bypassed.
const GRID_CACHE_VERSION = '6';

// Animated grid limits: frames per loop, and the byte budget Discord uploads allow.
const GIF_MAX_FRAMES = 150;
const GIF_MAX_BYTES = 7 * 1024 * 1024;
// Total pixels across all frames worth encoding inside one serverless call.
const GIF_PIXEL_BUDGET = 110e6;

const curIconData = {};

async function loadCurIcon(code) {
  if (curIconData[code] === undefined) {
    curIconData[code] = (await fetchIconData(CURRENCY_ICON_URLS[code])) || false;
  }
  return curIconData[code];
}
const emojiPromises = {};
const iconCache = new Map();

function cachedIcon(url) {
  if (!iconCache.has(url)) {
    const p = fetchIconData(url).then((d) => {
      if (!d) iconCache.delete(url);
      return d;
    });
    iconCache.set(url, p);
  }
  return iconCache.get(url);
}

async function loadEmoji(code) {
  if (emojiPromises[code] === undefined) {
    emojiPromises[code] = fetchIconData(
      `https://cdn.discordapp.com/emojis/${EMOJI_IDS[code]}.png?size=64`
    ).then((d) => {
      if (!d) delete emojiPromises[code];
      return d;
    });
  }
  return emojiPromises[code];
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Truncate on the raw name (before esc inflates entities) so long names fit
// the 560px cell instead of overflowing into neighbors.
function fitName(raw, max = 34) {
  const s = String(raw || 'Unknown');
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function nameSizeFor(label) {
  return label.length > 30 ? 25 : label.length > 22 ? 30 : 34;
}

function priceLabel(item) {
  const label = (item.currency && CURRENCY_LABEL[item.currency]) || String(item.currency || 'VP').toUpperCase();
  return `${item.price || 0} ${label}`;
}

// Lighter radial cell background so dark item art stays visible.
function cellDefs(extra = '') {
  return `<defs><radialGradient id="cellbg" cx="50%" cy="38%" r="80%"><stop offset="0%" stop-color="#2e3340"/><stop offset="100%" stop-color="#14171f"/></radialGradient>${extra}</defs>`;
}

const SHOP_FONTS = { fontFiles: [FONT, FONT_DISPLAY, FONT_MONO], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' };

// Player title names from the API often end with the category word itself
// ("Fortune Title"). Display just the title.
function titleName(name) {
  const stripped = String(name || '').replace(/\s+title$/i, '').trim();
  return stripped || String(name || 'Title');
}

// Player titles have no artwork. Render the title itself large in the icon
// zone so the cell is not just floating text.
function titleTextSvg(item, cx, cy, topOffset) {
  const raw = titleName(item.name);
  const maxW = ICON_W - 40;
  let size = 46;
  while (size > 20 && raw.length * 0.6 * size > maxW) size -= 2;
  const y = Math.round(cy + topOffset + ICON_H / 2 + size * 0.35);
  return `<text x="${cx + CELL_W / 2}" y="${y}" text-anchor="middle" font-family="DejaVu Sans" font-size="${size}" fill="#ffffff">${esc(raw)}</text>`;
}

function priceRow(item, cx, cy, curIcons) {
  const y = cy + 292;
  const centerX = cx + CELL_W / 2;
  const price = numStr(item.price);
  const vpIcon = curIcons[item.currency];
  if (vpIcon) {
    const fontSize = 28;
    const textW = price.length * 0.636 * fontSize;
    const iconSize = 28;
    const gap = 9;
    const startX = centerX - (textW + gap + iconSize) / 2;
    const iconY = y - Math.round(0.365 * fontSize + iconSize / 2);
    return (
      `<text x="${startX}" y="${y}" font-family="DejaVu Sans" font-size="${fontSize}" fill="#c9ced8">${price}</text>` +
      `<image xlink:href="${vpIcon}" x="${startX + textW + gap}" y="${iconY}" width="${iconSize}" height="${iconSize}"/>`
    );
  }
  return `<text x="${centerX}" y="${y}" text-anchor="middle" font-family="DejaVu Sans" font-size="28" fill="#c9ced8">${esc(priceLabel(item))}</text>`;
}

// ---- Shop card (mirrors the website's .card) ----------------------------------
// Media area on top (near-black, a soft glow in the item's tier colour rising
// from the bottom edge, and a tier-coloured rule under it), then the body: item
// name, and a row with the price on the left and the type or tier on the right.
const CARD_MEDIA_H = 196;
const CARD_ICON = { x: 25, y: 14, w: 510, h: 168 };
const CARD_TEXT = '#ececf0';
const CARD_MUTED = '#767a87';
const CARD_LINE = '#24262e';
const TIER_COLORS = {
  select: '#5a9fe2',
  deluxe: '#009587',
  premium: '#d1548d',
  exclusive: '#f5955b',
  ultra: '#fad663',
};
const TYPE_LABEL = { skin: 'Weapon skin', buddy: 'Gun buddy', spray: 'Spray', card: 'Player card', title: 'Title', flex: 'Flex' };

function tierColor(tier) {
  const key = String(tier || '').toLowerCase().replace(/\s*edition/g, '').trim();
  return TIER_COLORS[key] || null;
}

// Artwork a card should show: player cards use their wide banner.
function cardArtUrl(item) {
  if (item.type === 'card' && item.art && (item.art.wide || item.art.small)) return item.art.wide || item.art.small;
  return item.staticIcon || item.icon || null;
}

// Name size that fits the card width. DejaVu Sans averages about 0.58em a glyph.
function cardNameFit(raw) {
  const maxW = CELL_W - 44;
  let size = 28;
  while (size > 20 && String(raw).length * 0.58 * size > maxW) size -= 1;
  const cap = Math.floor(maxW / (0.58 * size));
  const s = String(raw);
  return { text: s.length > cap ? `${s.slice(0, Math.max(1, cap - 1))}...` : s, size };
}

function cardCell(item, i, cx, cy, icon, curIcons, opts = {}) {
  const color = tierColor(item.tier);
  const glow = color || '#8b929c';
  const gid = `cg${i}`;
  const cid = `cc${i}`;
  const defs =
    `<radialGradient id="${gid}" cx="50%" cy="100%" r="85%" fx="50%" fy="100%"><stop offset="0" stop-color="${glow}" stop-opacity=".28"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>` +
    `<clipPath id="${cid}"><rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CELL_H}" rx="10"/></clipPath>`;

  let s = `<g clip-path="url(#${cid})">`;
  s += `<rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CELL_H}" fill="#131419"/>`;
  s += `<rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CARD_MEDIA_H}" fill="#0e0f13"/>`;
  s += `<rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CARD_MEDIA_H}" fill="url(#${gid})"/>`;
  s += `<rect x="${cx}" y="${cy + CARD_MEDIA_H - 3}" width="${CELL_W}" height="3" fill="${color || CARD_LINE}" fill-opacity="${color ? 0.7 : 1}"/>`;
  if (item.type === 'title') {
    const raw = titleName(item.name).toUpperCase();
    let size = 46;
    while (size > 22 && raw.length * (0.5 * size + 2) > CARD_ICON.w - 20) size -= 2;
    const y = Math.round(cy + CARD_ICON.y + CARD_ICON.h / 2 + size * 0.36);
    s += `<text x="${cx + CELL_W / 2}" y="${y}" text-anchor="middle" font-family="Anton" font-size="${size}" letter-spacing="2" fill="${CARD_TEXT}">${esc(raw)}</text>`;
  } else if (icon) {
    s += `<image xlink:href="${icon}" x="${cx + CARD_ICON.x}" y="${cy + CARD_ICON.y}" width="${CARD_ICON.w}" height="${CARD_ICON.h}" preserveAspectRatio="xMidYMid meet"/>`;
  }

  const name = cardNameFit(item.name || 'Unknown');
  s += `<text x="${cx + 22}" y="${cy + CARD_MEDIA_H + 46}" font-family="DejaVu Sans" font-size="${name.size}" fill="${CARD_TEXT}">${esc(name.text)}</text>`;

  const base = cy + CELL_H - 26;
  const priceStr = item.price === null || item.price === undefined ? '-' : numStr(item.price);
  const curIcon = item.price === null || item.price === undefined ? null : curIcons && curIcons[item.currency || 'vp'];
  // Night Market: the pre-discount price, struck through, ahead of the new one.
  let px = cx + 22;
  if (opts.discount && item.basePrice != null && item.basePrice !== item.price) {
    const oldStr = numStr(item.basePrice);
    const oldW = oldStr.length * 0.6 * 20;
    s += `<text x="${px}" y="${base}" font-family="JetBrains Mono" font-size="20" fill="${CARD_MUTED}">${esc(oldStr)}</text>`;
    s += `<line x1="${px - 2}" y1="${base - 7}" x2="${px + oldW + 2}" y2="${base - 7}" stroke="${CARD_MUTED}" stroke-width="2"/>`;
    px += oldW + 14;
  }
  if (curIcon) {
    s += `<image xlink:href="${curIcon}" x="${px}" y="${base - 22}" width="26" height="26"/>`;
    s += `<text x="${px + 26 + 8}" y="${base}" font-family="JetBrains Mono" font-size="26" fill="${CARD_TEXT}">${esc(priceStr)}</text>`;
  } else {
    const label = item.price === null || item.price === undefined ? priceStr : priceLabel(item);
    s += `<text x="${px}" y="${base}" font-family="JetBrains Mono" font-size="26" fill="${CARD_TEXT}">${esc(label)}</text>`;
  }
  // Tier (in its colour) when the item has one, else the type when asked for.
  const tag = item.tier || (opts.showType && TYPE_LABEL[item.type]) || '';
  if (tag) {
    s += `<text x="${cx + CELL_W - 22}" y="${base - 1}" text-anchor="end" font-family="Anton" font-size="20" letter-spacing="2" fill="${item.tier && color ? color : CARD_MUTED}">${esc(String(tag).toUpperCase())}</text>`;
  }
  s += '</g>';
  s += `<rect x="${cx + 1}" y="${cy + 1}" width="${CELL_W - 2}" height="${CELL_H - 2}" rx="9" fill="none" stroke="${CARD_LINE}" stroke-width="2"/>`;
  if (opts.discount && item.discount) {
    const pct = `-${item.discount}%`;
    const bw = pct.length * 13 + 18;
    s += `<rect x="${cx + 14}" y="${cy + 14}" width="${bw}" height="32" rx="4" fill="#ff4655"/>`;
    s += `<text x="${cx + 14 + bw / 2}" y="${cy + 37}" text-anchor="middle" font-family="JetBrains Mono" font-size="21" fill="#ffffff">${pct}</text>`;
  }
  if (opts.wished) {
    s += `<rect x="${cx + CELL_W - 52}" y="${cy + 12}" width="40" height="40" rx="6" fill="#0b0c0f" fill-opacity=".72" stroke="#f4c150" stroke-opacity=".5" stroke-width="2"/>`;
    s += wishStar(cx + CELL_W - 32, cy + 32, 14);
  }
  return { defs, svg: s };
}

async function fetchIconData(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length) return null;
    const mime = /\.webp(\?|$)/i.test(url)
      ? 'image/webp'
      : /\.jpe?g(\?|$)/i.test(url)
        ? 'image/jpeg'
        : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function walletRows(wallet) {
  return [
    { code: 'vp', value: wallet.vp ?? null },
    { code: 'rp', value: wallet.rp ?? null },
    { code: 'kc', value: wallet.kc ?? null },
  ];
}

function shortNum(n) {
  const v = Number(n) || 0;
  if (v > 9999) {
    const k = (v / 1000).toFixed(1);
    return `${k.endsWith('.0') ? k.slice(0, -2) : k}k`;
  }
  return String(Math.round(v));
}

// Prices are integers; never render a trailing ".0".
function numStr(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(Math.round(v)) : '0';
}

// Small native-looking 5-point star used to mark wishlisted cells.
function wishStar(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 10; i += 1) {
    const ang = (Math.PI / 5) * i - Math.PI / 2;
    const rad = i % 2 === 0 ? r : r * 0.44;
    pts.push(`${(cx + rad * Math.cos(ang)).toFixed(1)},${(cy + rad * Math.sin(ang)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="#f4c150" stroke="#12141a" stroke-width="1.5" stroke-linejoin="round"/>`;
}

function rowSvg(r, x, centerY, emojis) {
  const label = r.value == null ? '?' : shortNum(r.value);
  if (emojis[r.code]) {
    const iconSize = 50;
    return (
      `<image xlink:href="${emojis[r.code]}" x="${x}" y="${centerY - iconSize / 2}" width="${iconSize}" height="${iconSize}"/>` +
      `<text x="${x + iconSize + 12}" y="${centerY + 15}" font-family="DejaVu Sans" font-size="40" fill="#ffffff">${label}</text>`
    );
  }
  return `<text x="${x}" y="${centerY + 14}" font-family="DejaVu Sans" font-size="36" fill="#ffffff">${esc(r.code.toUpperCase() + ' ' + label)}</text>`;
}

async function renderWalletImage(wallet) {
  if (!wallet) return null;
  const rows = walletRows(wallet);
  const PADW = 16;
  const ROW = 64;
  const S = 264;
  const top = (S - ROW * rows.length) / 2;
  const [vpE, rpE, kcE] = await Promise.all(['vp', 'rp', 'kc'].map((c) => loadEmoji(c)));
  const emojis = { vp: vpE, rp: rpE, kc: kcE };
  let s = '';
  rows.forEach((r, i) => {
    s += rowSvg(r, PADW, top + i * ROW + ROW / 2, emojis);
  });
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${S}" height="${S}">` +
    `${s}</svg>`;
  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  });
  return resvg.render().asPng();
}

async function renderSkinGrid(store, opts = {}) {
  const source = opts.items || (store && store.daily && store.daily.items) || [];
  const items = source.slice(0, opts.limit || 4);
  if (!items.length) return null;

  const icons = await Promise.all(
    items.map((i) => {
      const url = cardArtUrl(i);
      return url ? fetchIconData(url) : Promise.resolve(null);
    })
  );
  const [vpI, kcI] = await Promise.all([loadCurIcon('vp'), loadCurIcon('kc')]);
  const curIcons = { vp: vpI, kc: kcI };

  const cols = opts.cols || 2;
  const rows = Math.ceil(items.length / cols);
  const W = PAD * 2 + CELL_W * cols + GAP * (cols - 1);
  const H = PAD * 2 + CELL_H * rows + GAP * (rows - 1);
  const wl = Array.isArray(opts.wishlist) ? opts.wishlist : null;
  const wlIds = wl ? new Set(wl.map((x) => (x && x.id != null ? String(x.id) : '')).filter(Boolean)) : null;
  const wlNames = wl
    ? new Set(wl.map((x) => normalizeName(x && x.name)).filter(Boolean))
    : null;
  const isWished = (item) => {
    if (!wl) return false;
    if (wlIds && wlIds.size && wlIds.has(String(item.id))) return true;
    const n = item.name ? normalizeName(item.name) : '';
    return Boolean(n && wlNames && wlNames.size && wlNames.has(n));
  };
  const lastRowCount = items.length - (rows - 1) * cols;
  const lastRowW = lastRowCount * CELL_W + (lastRowCount - 1) * GAP;
  const lastRowX = PAD + (W - PAD * 2 - lastRowW) / 2;

  let cells = '';
  let cardDefs = '';
  items.forEach((item, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const cx = row === rows - 1 ? lastRowX + col * (CELL_W + GAP) : PAD + col * (CELL_W + GAP);
    const cy = PAD + row * (CELL_H + GAP);
    const c = cardCell(item, i, cx, cy, icons[i], curIcons, { showType: opts.showType, discount: Boolean(opts.discount), wished: isWished(item) });
    cardDefs += c.defs;
    cells += c.svg;
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">` +
    cellDefs(cardDefs) +
    `${cells}</svg>`;

  const resvg = new Resvg(svg, { font: SHOP_FONTS });
  return resvg.render().asPng();
}

// ---- Animated (GIF) grid -----------------------------------------------------
// The accessory shop can contain sprays, which have animated GIF artwork. A
// single static PNG grid can't show that, so we render the grid once without
// the animated cells' artwork, decode each spray GIF into its frames, paint the
// current frame into each spray cell, and encode the whole thing as one
// animated GIF. Everything that isn't a spray stays perfectly still.

function isGifUrl(url) {
  return typeof url === 'string' && /\.gif(\?|$)/i.test(url);
}

function clearRect(buf, w, h, x, y, rw, rh) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  const x1 = Math.min(w, x + rw);
  const y1 = Math.min(h, y + rh);
  for (let yy = y0; yy < y1; yy++) {
    let i = (yy * w + x0) * 4;
    for (let xx = x0; xx < x1; xx++) {
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = 0;
      i += 4;
    }
  }
}

// Decode an animated GIF into full-canvas RGBA frames (straight alpha) + delays.
// GIF frames are deltas, so each frame's disposal method must be applied before
// the next one is drawn, otherwise the earlier frames bleed through (trails).
function decodeGif(buf) {
  const reader = new GifReader(buf);
  const w = reader.width;
  const h = reader.height;
  const canvas = new Uint8Array(w * h * 4);
  let saved = null;
  let prev = null;
  const frames = [];
  const n = reader.numFrames();
  for (let i = 0; i < n; i++) {
    const info = reader.frameInfo(i);
    if (prev) {
      if (prev.disposal === 2) {
        clearRect(canvas, w, h, prev.x, prev.y, prev.width, prev.height);
      } else if (prev.disposal === 3 && saved) {
        canvas.set(saved);
      }
    }
    if (info.disposal === 3) saved = Uint8Array.from(canvas);
    reader.decodeAndBlitFrameRGBA(i, canvas);
    frames.push({
      data: Uint8Array.from(canvas),
      delay: Math.max(20, Math.round((info.delay || 10) * 10)),
    });
    prev = info;
  }
  return { w, h, frames };
}

// Append every `step`-th opaque pixel of an RGBA image (as RGBA) to `out`.
function collectSample(src, step, out) {
  const stride = step * 4;
  for (let i = 0; i < src.length; i += stride) {
    if (src[i + 3] === 0) continue;
    out.push(src[i], src[i + 1], src[i + 2], 255);
  }
}

// Map RGBA pixels to palette indices using an exact 24-bit RGB key. gifenc's
// applyPalette caches by a lossy rgb565 key, so the same background pixel can
// land on a different palette entry depending on where the *changing* pixels
// appear in scan order â€” which made the static background shimmer frame to
// frame. Keying on the exact RGB (shared across a shop's frames) is stable.
//
// A single reserved `transparentIndex` paints pixels below `alphaThreshold`
// transparent (so the gaps around the rounded cells aren't a black box), and an
// ordered Bayer offset `dither` breaks up the 8-bit banding on the background
// gradient. Both are position-based, so identical pixels stay identical across
// frames and the background never shimmers.
const BAYER8 = (() => {
  const m = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
  ];
  const a = new Float32Array(64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) a[(y << 3) | x] = m[y][x] / 64 - 0.5;
  return a;
})();

function makePaletteIndexer(palette, transparentIndex, alphaThreshold, dither, width) {
  const cache = new Uint16Array(1 << 24); // rgb -> index+1 (0 = not computed)
  const plen = transparentIndex; // opaque entries are [0, plen)
  return function indexFrame(rgba) {
    const n = rgba.length >> 2;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const i = k << 2;
      if (rgba[i + 3] < alphaThreshold) {
        out[k] = transparentIndex;
        continue;
      }
      let r = rgba[i];
      let g = rgba[i + 1];
      let b = rgba[i + 2];
      if (dither > 0) {
        const o = BAYER8[((((k / width) | 0) & 7) << 3) | ((k % width) & 7)] * dither;
        r = r + o < 0 ? 0 : r + o > 255 ? 255 : r + o;
        g = g + o < 0 ? 0 : g + o > 255 ? 255 : g + o;
        b = b + o < 0 ? 0 : b + o > 255 ? 255 : b + o;
      }
      const key = (r << 16) | (g << 8) | b;
      let v = cache[key];
      if (v === 0) {
        let best = 0;
        let bestD = Infinity;
        for (let p = 0; p < plen; p++) {
          const c = palette[p];
          const dr = c[0] - r;
          const dg = c[1] - g;
          const db = c[2] - b;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestD) {
            bestD = d;
            best = p;
            if (d === 0) break;
          }
        }
        v = best + 1;
        cache[key] = v;
      }
      out[k] = v - 1;
    }
    return out;
  };
}

// Draw `src` (straight-alpha RGBA) fitted ("meet") and centered into a box on
// `dst` (straight RGBA). The destination inside a cell is opaque, so a plain
// over-blend is accurate.
function bilinearInto(dst, dstW, dstH, boxX, boxY, boxW, boxH, src, srcW, srcH) {
  const scale = Math.min(boxW / srcW, boxH / srcH);
  const dw = Math.max(1, Math.round(srcW * scale));
  const dh = Math.max(1, Math.round(srcH * scale));
  const ox = boxX + Math.round((boxW - dw) / 2);
  const oy = boxY + Math.round((boxH - dh) / 2);
  for (let y = 0; y < dh; y++) {
    const sy = ((y + 0.5) * srcH) / dh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = Math.max(0, sy - y0);
    for (let x = 0; x < dw; x++) {
      const sx = ((x + 0.5) * srcW) / dw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = Math.max(0, sx - x0);
      const i00 = (y0 * srcW + x0) * 4;
      const i10 = (y0 * srcW + x1) * 4;
      const i01 = (y1 * srcW + x0) * 4;
      const i11 = (y1 * srcW + x1) * 4;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      const r = src[i00] * w00 + src[i10] * w10 + src[i01] * w01 + src[i11] * w11;
      const g = src[i00 + 1] * w00 + src[i10 + 1] * w10 + src[i01 + 1] * w01 + src[i11 + 1] * w11;
      const b = src[i00 + 2] * w00 + src[i10 + 2] * w10 + src[i01 + 2] * w01 + src[i11 + 2] * w11;
      const a = (src[i00 + 3] * w00 + src[i10 + 3] * w10 + src[i01 + 3] * w01 + src[i11 + 3] * w11) / 255;
      if (a <= 0) continue;
      const di = ((oy + y) * dstW + (ox + x)) * 4;
      dst[di] = Math.round(r * a + dst[di] * (1 - a));
      dst[di + 1] = Math.round(g * a + dst[di + 1] * (1 - a));
      dst[di + 2] = Math.round(b * a + dst[di + 2] * (1 - a));
      dst[di + 3] = 255;
    }
  }
}

// Returns a Buffer containing an animated GIF grid, or null when the shop has
// no animated (spray) items or none of their GIFs could be decoded â€” in which
// case the caller should fall back to the static PNG grid.
async function renderAnimatedSkinGrid(store, opts = {}) {
  const source = opts.items || (store && store.daily && store.daily.items) || [];
  const items = source.slice(0, opts.limit || 4);
  if (!items.length) return null;

  const animIdx = [];
  items.forEach((it, i) => {
    if (it.type !== 'title' && isGifUrl(it.icon)) animIdx.push(i);
  });
  if (!animIdx.length) return null;

  // Decode each animated item's GIF. Items whose GIF fails to decode are simply
  // rendered statically instead of aborting the whole message.
  const animated = [];
  await Promise.all(
    animIdx.map(async (i) => {
      try {
        const r = await fetch(items[i].icon, { signal: AbortSignal.timeout(12000) });
        if (!r.ok) return;
        const g = decodeGif(Buffer.from(await r.arrayBuffer()));
        if (g.frames.length) animated.push({ index: i, ...g });
      } catch {
        /* fall back to the static icon for this cell */
      }
    })
  );
  animated.sort((a, b) => a.index - b.index);
  if (!animated.length) return null;
  const animSet = new Set(animated.map((a) => a.index));

  const staticIcons = await Promise.all(
    items.map((it, i) => {
      if (animSet.has(i)) return Promise.resolve(null);
      const url = cardArtUrl(it);
      return url ? fetchIconData(url) : Promise.resolve(null);
    })
  );
  const [vpI, kcI] = await Promise.all([loadCurIcon('vp'), loadCurIcon('kc')]);
  const curIcons = { vp: vpI, kc: kcI };

  const cols = opts.cols || 2;
  const rows = Math.ceil(items.length / cols);
  const W = PAD * 2 + CELL_W * cols + GAP * (cols - 1);
  const H = PAD * 2 + CELL_H * rows + GAP * (rows - 1);
  const showType = opts.showType !== false;
  const wl = Array.isArray(opts.wishlist) ? opts.wishlist : null;
  const wlIds = wl ? new Set(wl.map((x) => (x && x.id != null ? String(x.id) : '')).filter(Boolean)) : null;
  const wlNames = wl ? new Set(wl.map((x) => normalizeName(x && x.name)).filter(Boolean)) : null;
  const isWished = (item) => {
    if (!wl) return false;
    if (wlIds && wlIds.size && wlIds.has(String(item.id))) return true;
    const n = item.name ? normalizeName(item.name) : '';
    return Boolean(n && wlNames && wlNames.size && wlNames.has(n));
  };
  const lastRowCount = items.length - (rows - 1) * cols;
  const lastRowW = lastRowCount * CELL_W + (lastRowCount - 1) * GAP;
  const lastRowX = PAD + (W - PAD * 2 - lastRowW) / 2;

  let cells = '';
  let cardDefs = '';
  const positions = items.map((item, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const cx = row === rows - 1 ? lastRowX + col * (CELL_W + GAP) : PAD + col * (CELL_W + GAP);
    const cy = PAD + row * (CELL_H + GAP);
    // Animated cells are drawn without artwork here; each frame paints it in.
    const c = cardCell(item, i, cx, cy, staticIcons[i], curIcons, { showType, wished: isWished(item) });
    cardDefs += c.defs;
    cells += c.svg;
    return { cx, cy };
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">` +
    cellDefs(cardDefs) +
    `${cells}</svg>`;

  const rendered = new Resvg(svg, { font: SHOP_FONTS }).render();
  const base = Uint8Array.from(rendered.pixels);
  const BW = rendered.width;
  const BH = rendered.height;

  // A single GIF frame delay is shared by every cell, so each spray keeps its own
  // playback clock. The tick is the smallest source frame delay, so no source
  // frame is ever shorter than a tick: slow sprays just hold a frame for a few
  // ticks and every spray plays at its true speed. The GIF spans the longest
  // spray's full cycle so nothing restarts mid-animation. (Sampling one shared
  // wall-clock instead aliased against uneven frame delays and dropped frames.)
  const delaysOf = animated.map((a) => a.frames.map((fr) => fr.delay));
  const baseTick = Math.max(20, Math.min(...delaysOf.flat()));
  const maxCycle = Math.max(...delaysOf.map((d) => d.reduce((s, x) => s + x, 0)));

  // A single palette shared by every frame is written once as the global colour
  // table. Re-quantizing per frame made the (frame-identical) background
  // gradient shimmer, since each frame got its own slightly different palette.
  const samples = [];
  collectSample(base, 6, samples);
  for (const a of animated) {
    collectSample(a.frames[0].data, 16, samples);
    if (a.frames.length > 1) collectSample(a.frames[a.frames.length >> 1].data, 16, samples);
  }
  const palette = quantize(Uint8Array.from(samples), 255, { format: 'rgb565' });
  palette.push([0, 0, 0]); // reserved transparent slot
  const transparentIndex = palette.length - 1;
  const indexFrame = makePaletteIndexer(palette, transparentIndex, 128, opts.dither ?? 16, BW);

  const encode = (tickMs) => {
    const clips = animated.map((a, k) => ({ a, delays: delaysOf[k], idx: 0, clock: 0 }));
    const frameCount = Math.min(GIF_MAX_FRAMES, Math.max(2, Math.ceil(maxCycle / tickMs)));
    const gif = GIFEncoder();
    let prev = null;
    for (let f = 0; f < frameCount; f++) {
      const frame = Uint8Array.from(base);
      for (const c of clips) {
        if (f > 0) {
          c.clock += tickMs;
          while (c.clock >= c.delays[c.idx]) {
            c.clock -= c.delays[c.idx];
            c.idx = (c.idx + 1) % c.a.frames.length;
          }
        }
        const pos = positions[c.a.index];
        bilinearInto(
          frame,
          BW,
          BH,
          pos.cx + CARD_ICON.x,
          pos.cy + CARD_ICON.y,
          CARD_ICON.w,
          CARD_ICON.h,
          c.a.frames[c.idx].data,
          c.a.w,
          c.a.h
        );
      }
      const index = indexFrame(frame);
      // Frames after the first only carry the pixels that changed; everything
      // else is the transparent index, which shows the previous frame through
      // (disposal 1 keeps it). Static cards cost almost nothing per frame, so
      // long sprays fit in the upload limit without being cut short.
      let out = index;
      if (prev) {
        out = new Uint8Array(index.length);
        for (let k = 0; k < index.length; k++) out[k] = index[k] === prev[k] ? transparentIndex : index[k];
      }
      prev = index;
      const frameOpts = { transparent: true, transparentIndex, delay: tickMs, dispose: 1 };
      if (f === 0) frameOpts.palette = palette;
      gif.writeFrame(out, BW, BH, frameOpts);
    }
    gif.finish();
    return Buffer.from(gif.bytes());
  };

  // If the result is over the upload budget, play it back on a coarser tick
  // (fewer frames, same speed) instead of dropping the animation.
  const frameCap = Math.max(24, Math.min(GIF_MAX_FRAMES, Math.round(GIF_PIXEL_BUDGET / (BW * BH))));
  let tick = Math.max(baseTick, Math.ceil(maxCycle / frameCap));
  let out = encode(tick);
  for (let attempt = 0; attempt < 3 && out.length > GIF_MAX_BYTES; attempt++) {
    tick = Math.round(tick * 1.5);
    out = encode(tick);
  }
  return out.length > GIF_MAX_BYTES ? null : out;
}

function vpChunkWidth(numStr, fontSize, iconSize, vpIcon) {
  if (vpIcon) return numStr.length * 0.636 * fontSize + 8 + iconSize;
  return (numStr + ' VP').length * 0.636 * fontSize;
}

function vpChunkDraw(numStr, fontSize, iconSize, vpIcon, x, y, color) {
  if (vpIcon) {
    const textW = numStr.length * 0.636 * fontSize;
    const iconY = y - Math.round(0.365 * fontSize + iconSize / 2);
    return (
      `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${fontSize}" fill="${color}">${esc(numStr)}</text>` +
      `<image xlink:href="${vpIcon}" x="${x + textW + 8}" y="${iconY}" width="${iconSize}" height="${iconSize}"/>`
    );
  }
  return `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${fontSize}" fill="${color}">${esc(numStr + ' VP')}</text>`;
}

function pricePairRow(discStr, baseStr, percent, cx, cy, icon) {
  const y = cy + 292;
  const showBase = Boolean(baseStr != null && baseStr !== discStr);
  const pStr = percent ? `-${percent}%` : null;
  let dSize = 30;
  let bSize = 22;
  let pSize = 22;
  let dIcon = 30;
  let bIcon = 22;
  const widthFor = () => {
    const dW = vpChunkWidth(discStr, dSize, dIcon, icon);
    const bW = showBase ? vpChunkWidth(baseStr, bSize, bIcon, icon) : 0;
    const pW = pStr ? pStr.length * 0.636 * pSize : 0;
    return dW + (showBase ? 16 : 0) + bW + (pStr ? 14 : 0) + pW;
  };
  // Shrink rows that would run into the bottom-right tier badge.
  const maxW = CELL_W - 170;
  if (widthFor() > maxW) {
    const k = maxW / widthFor();
    dSize = Math.max(16, Math.floor(dSize * k));
    bSize = Math.max(14, Math.floor(bSize * k));
    pSize = Math.max(14, Math.floor(pSize * k));
    dIcon = Math.max(16, Math.floor(dIcon * k));
    bIcon = Math.max(14, Math.floor(bIcon * k));
  }
  const dW = vpChunkWidth(discStr, dSize, dIcon, icon);
  const bW = showBase ? vpChunkWidth(baseStr, bSize, bIcon, icon) : 0;
  const pW = pStr ? pStr.length * 0.636 * pSize : 0;
  const gap1 = showBase ? 16 : 0;
  const gap2 = pStr ? 14 : 0;
  const startX = cx + CELL_W / 2 - (dW + gap1 + bW + gap2 + pW) / 2;
  let out = vpChunkDraw(discStr, dSize, dIcon, icon, startX, y, '#ffffff');
  let x = startX + dW;
  if (showBase) {
    x += gap1;
    out += vpChunkDraw(baseStr, bSize, bIcon, icon, x, y, '#8b93a5');
    const strikeW = icon ? baseStr.length * 0.636 * bSize : (baseStr + ' VP').length * 0.636 * bSize;
    out += `<line x1="${x - 2}" y1="${y - 8}" x2="${x + strikeW + 2}" y2="${y - 8}" stroke="#8b93a5" stroke-width="2"/>`;
    x += bW;
  }
  if (pStr) {
    x += gap2;
    out += `<text x="${x}" y="${y}" font-family="DejaVu Sans" font-size="${pSize}" fill="#7bd88f">${esc(pStr)}</text>`;
  }
  return out;
}

function discountPriceRow(item, cx, cy, curIcons) {
  const icon = (curIcons && (curIcons[item.currency] || curIcons.vp)) || null;
  const discStr = numStr(item.price);
  const baseStr = item.basePrice != null ? numStr(item.basePrice) : null;
  return pricePairRow(discStr, baseStr, item.discount, cx, cy, icon);
}

// Bundle items as shop-card items, so /bundle looks like the daily shop. Priced
// at their base value like the website: the discount applies to the whole bundle.
async function bundleCardItems(bundleItems) {
  const list = (bundleItems || []).slice(0, 20);
  if (!list.length) return [];
  await loadItems().catch(() => {});
  return list.map((it) => {
    const r = resolveItem(it.id);
    return {
      id: it.id,
      name: r.name,
      type: r.type,
      icon: r.icon,
      staticIcon: r.staticIcon,
      art: r.art,
      tier: r.tier,
      price: it.base != null ? it.base : it.disc,
      currency: 'vp',
    };
  });
}

function bundleCols(count) {
  return count <= 4 ? 2 : 3;
}

async function renderBundleGrid(bundleItems) {
  const items = await bundleCardItems(bundleItems);
  if (!items.length) return null;
  return renderSkinGrid(null, { items, limit: 20, cols: bundleCols(items.length), showType: true });
}

async function renderAnimatedBundleGrid(bundleItems) {
  const items = await bundleCardItems(bundleItems);
  if (!items.length) return null;
  return renderAnimatedSkinGrid(null, { items, limit: 20, cols: bundleCols(items.length), showType: true });
}

// An animated GIF when the bundle has an animated spray, else the PNG grid.
async function renderBundleMedia(bundleItems) {
  const gif = await renderAnimatedBundleGrid(bundleItems).catch(() => null);
  if (gif) return { name: 'bundle-grid.gif', buf: gif };
  const png = await renderBundleGrid(bundleItems);
  return png ? { name: 'bundle-grid.png', buf: png } : null;
}

// Card chrome shared by the rank and collection renders, matching the shop
// cards: near-black surface, a soft glow in the accent colour rising from the
// bottom edge, an accent rule along the bottom and a 1px border.
function cardFrame(W, H, accent, rx = 12) {
  const c = /^#?ffffff$/i.test(String(accent || '')) ? '#9aa0a6' : accent || '#8b929c';
  return (
    `<defs><radialGradient id="fglow" cx="50%" cy="100%" r="85%" fx="50%" fy="100%"><stop offset="0" stop-color="${c}" stop-opacity=".24"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>` +
    `<clipPath id="fclip"><rect width="${W}" height="${H}" rx="${rx}"/></clipPath></defs>` +
    `<g clip-path="url(#fclip)"><rect width="${W}" height="${H}" fill="#131419"/><rect width="${W}" height="${H}" fill="url(#fglow)"/>` +
    `<rect y="${H - 3}" width="${W}" height="3" fill="${c}" fill-opacity=".7"/></g>` +
    `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="${rx - 0.5}" fill="none" stroke="#24262e"/>`
  );
}

// ---- Rank card ---------------------------------------------------------------
// The /rank render is a fixed-size transparent card, so every rank lays out the
// same way no matter how long its name is:
//
//   [        ]  RANK NAME
//   [ EMBLEM ]  67 RR / 100                   LEADERBOARD #38
//   [        ]  [==================------------------------]
//               PEAK [e] IMMORTAL 2                  LEVEL 214
//
// The emblem is cropped to its ink box and fills a square slot. The rank name
// shrinks to fit the column. The meter fills to RR/100 below Immortal; RR is
// uncapped from Immortal up, so there the meter is full and the leaderboard
// placement (when Riot reports one) sits right-aligned on the RR row. Unranked
// accounts get the same card with a "no placement" line instead of RR. The peak
// line and level only appear when the data is there. Rendered at 2x via
// viewBox so Discord's gallery scaling stays crisp.
function rankColorHex(color) {
  const m = /^#?([0-9a-fA-F]{6})/.exec(String(color || ''));
  return m ? `#${m[1].toLowerCase()}` : '#ff4655';
}

async function emblemSvg(url, x, y, size) {
  const icon = url ? await fetchIconData(url) : null;
  if (!icon) return '';
  const crop = await iconCrop(icon);
  if (!crop) return `<image xlink:href="${icon}" x="${x}" y="${y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid meet"/>`;
  // Square viewBox around the ink box keeps the emblem centred in its slot.
  const side = Math.max(crop.w, crop.h);
  const vx = crop.x - (side - crop.w) / 2;
  const vy = crop.y - (side - crop.h) / 2;
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="${vx} ${vy} ${side} ${side}" preserveAspectRatio="xMidYMid meet"><image xlink:href="${icon}" x="0" y="0" width="${crop.aw}" height="${crop.ah}"/></svg>`;
}

async function renderRankImage(rank, opts = {}) {
  if (!rank) return null;
  const SCALE = 2;
  const WHITE = '#f2f2f3';
  const MUTED = '#9a9aa3';
  const TRACK = '#3a3b44';
  const color = rankColorHex(rank.color);
  const tierNum = Number(rank.tier) || 0;
  const unranked = tierNum < 3;
  const isTop = tierNum >= 24;
  const rawRr = Math.max(0, Math.round(Number(rank.rr) || 0));
  const lb = isTop ? Math.round(Number(rank.leaderboard) || 0) : 0;
  const level = Number(opts.level) || 0;
  const peakTier = Number(rank.peakTier) || 0;
  const hasPeak = peakTier >= 3 && Boolean(rank.peakName);
  const hasFoot = hasPeak || level > 0;

  const W = 600;
  const P = 22;
  const EMB = 132;
  const GAP = 26;
  const COL_X = P + EMB + GAP;
  const COL_W = W - COL_X - P;
  const BAR_H = 8;
  const FOOT_H = 20;

  // Rank name: Anton, shrunk until it fits the column.
  const name = String(rank.tierName || 'Unranked').toUpperCase();
  let nameSize = 50;
  let nameM = measureText(name, nameSize, 'Anton', FONT_DISPLAY);
  while (nameM.w > COL_W && nameSize > 30) {
    nameSize -= 2;
    nameM = measureText(name, nameSize, 'Anton', FONT_DISPLAY);
  }
  // Cap height from a fixed reference so every rank's rows sit at the same y.
  const refM = measureText('IRON 1', nameSize, 'Anton', FONT_DISPLAY);

  // Row heights come from measured ink boxes so the column stacks exactly.
  const numM = measureText('0123456789', 26, 'JetBrains Mono', FONT_MONO);
  const capM = measureText('LEVEL', 13, 'DejaVu Sans', FONT, 2);
  const colH = refM.top + 16 + numM.top + 12 + BAR_H + (hasFoot ? 18 + FOOT_H : 0);
  const H = Math.max(EMB, colH) + 2 * P;
  const top = Math.round((H - colH) / 2);

  let s = cardFrame(W, H, color) + (await emblemSvg(rank.icon, P, Math.round((H - EMB) / 2), EMB));

  const nameBase = top + refM.top;
  s += `<text x="${COL_X - nameM.x0}" y="${nameBase}" font-family="Anton" font-size="${nameSize}" fill="${WHITE}">${esc(name)}</text>`;

  const rrBase = nameBase + 16 + numM.top;
  if (unranked) {
    s += `<text x="${COL_X}" y="${rrBase}" font-family="DejaVu Sans" font-size="18" fill="${MUTED}">No placement this act</text>`;
  } else {
    const rrStr = String(rawRr);
    const rrM = measureText(rrStr, 26, 'JetBrains Mono', FONT_MONO);
    s += `<text x="${COL_X - rrM.x0}" y="${rrBase}" font-family="JetBrains Mono" font-size="26" fill="${WHITE}">${esc(rrStr)}</text>`;
    s += `<text x="${COL_X + rrM.w + 8}" y="${rrBase}" font-family="JetBrains Mono" font-size="17" fill="${MUTED}">${isTop ? 'RR' : 'RR / 100'}</text>`;
    if (lb) {
      const lbStr = `#${lb}`;
      const lbM = measureText(lbStr, 26, 'JetBrains Mono', FONT_MONO);
      const lbX = COL_X + COL_W - lbM.w;
      s += `<text x="${lbX - lbM.x0}" y="${rrBase}" font-family="JetBrains Mono" font-size="26" fill="${color}">${esc(lbStr)}</text>`;
      const tagM = measureText('LEADERBOARD', 13, 'DejaVu Sans', FONT, 2);
      s += `<text x="${lbX - 10 - tagM.w - tagM.x0}" y="${rrBase}" font-family="DejaVu Sans" font-size="13" letter-spacing="2" fill="${MUTED}">LEADERBOARD</text>`;
    }
  }

  const barY = rrBase + 12;
  s += `<rect x="${COL_X}" y="${barY}" width="${COL_W}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${TRACK}"/>`;
  const fill = unranked ? 0 : isTop ? 1 : Math.min(100, rawRr) / 100;
  if (fill > 0) {
    s += `<rect x="${COL_X}" y="${barY}" width="${Math.max(BAR_H, Math.round(COL_W * fill))}" height="${BAR_H}" rx="${BAR_H / 2}" fill="${color}"/>`;
  }

  if (hasFoot) {
    const footMid = barY + BAR_H + 18 + FOOT_H / 2;
    const capBase = Math.round(footMid + (capM.top - capM.bottom) / 2);
    if (hasPeak) {
      const peakM = measureText('PEAK', 13, 'DejaVu Sans', FONT, 2);
      s += `<text x="${COL_X - peakM.x0}" y="${capBase}" font-family="DejaVu Sans" font-size="13" letter-spacing="2" fill="${MUTED}">PEAK</text>`;
      const ex = COL_X + peakM.w + 10;
      const mini = await emblemSvg(rank.peakIcon, ex, Math.round(footMid - FOOT_H / 2), FOOT_H);
      s += mini;
      const pn = String(rank.peakName).toUpperCase();
      const pnM = measureText(pn, 15, 'DejaVu Sans', FONT, 1);
      const pnBase = Math.round(footMid + (pnM.top - pnM.bottom) / 2);
      s += `<text x="${ex + (mini ? FOOT_H + 8 : 0) - pnM.x0}" y="${pnBase}" font-family="DejaVu Sans" font-size="15" letter-spacing="1" fill="${WHITE}">${esc(pn)}</text>`;
    }
    if (level > 0) {
      const lvStr = String(level);
      const lvM = measureText(lvStr, 15, 'JetBrains Mono', FONT_MONO);
      const lvX = COL_X + COL_W - lvM.w;
      const lvBase = Math.round(footMid + (lvM.top - lvM.bottom) / 2);
      s += `<text x="${lvX - lvM.x0}" y="${lvBase}" font-family="JetBrains Mono" font-size="15" fill="${WHITE}">${esc(lvStr)}</text>`;
      s += `<text x="${lvX - 8 - capM.w - capM.x0}" y="${capBase}" font-family="DejaVu Sans" font-size="13" letter-spacing="2" fill="${MUTED}">LEVEL</text>`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">` +
    `${s}</svg>`;
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT, FONT_DISPLAY, FONT_MONO],
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Sans',
    },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

// /collection stat card: two columns (weapon skins | accessories) side by side,
// each with a small caps label, a big total, a short red rule and its
// breakdown rows. Transparent like the rank card so it sits on Discord's
// container, rendered at 2x for crisp gallery scaling.
async function renderCollectionImage(columns) {
  if (!Array.isArray(columns) || !columns.length) return null;
  const SCALE = 2;
  const WHITE = '#f2f2f3';
  const MUTED = '#9a9aa3';
  const TRACK = '#3a3b44';
  const RED = '#ff4655';
  const P = 22;
  const COL_W = 240;
  const GUTTER = 56;
  const LABEL = 15;
  const BIG = 58;
  const ROW_H = 32;
  const W = 2 * P + columns.length * COL_W + (columns.length - 1) * GUTTER;

  const labelM = measureText('WEAPON SKINS', LABEL, 'DejaVu Sans', FONT, 3);
  const bigM = measureText('0123456789', BIG, 'Anton', FONT_DISPLAY);
  const labelBase = P + labelM.top;
  const bigBase = labelBase + labelM.bottom + 14 + bigM.top;
  const ruleY = bigBase + 16;
  const rowsTop = ruleY + 14;
  const maxRows = Math.max(...columns.map((c) => (c.rows || []).length));
  const H = rowsTop + maxRows * ROW_H + P - 6;

  let s = cardFrame(W, H, RED);
  columns.forEach((col, i) => {
    const x = P + i * (COL_W + GUTTER);
    s += `<text x="${x}" y="${labelBase}" font-family="DejaVu Sans" font-size="${LABEL}" letter-spacing="3" fill="${MUTED}">${esc(String(col.label).toUpperCase())}</text>`;
    s += `<text x="${x}" y="${bigBase}" font-family="Anton" font-size="${BIG}" fill="${WHITE}">${esc(numStr(col.total))}</text>`;
    s += `<rect x="${x}" y="${ruleY}" width="${COL_W}" height="3" fill="${TRACK}"/>`;
    s += `<rect x="${x}" y="${ruleY}" width="56" height="3" fill="${RED}"/>`;
    (col.rows || []).forEach((r, j) => {
      const base = rowsTop + j * ROW_H + 21;
      s += `<text x="${x}" y="${base}" font-family="DejaVu Sans" font-size="18" fill="${MUTED}">${esc(r.label)}</text>`;
      s += `<text x="${x + COL_W}" y="${base}" text-anchor="end" font-family="JetBrains Mono" font-size="20" fill="${WHITE}">${esc(numStr(r.value))}</text>`;
    });
    if (i < columns.length - 1) {
      const dx = x + COL_W + GUTTER / 2;
      s += `<rect x="${dx - 1}" y="${P}" width="2" height="${H - 2 * P}" fill="${TRACK}"/>`;
    }
  });

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}">` +
    `${s}</svg>`;
  const resvg = new Resvg(svg, {
    font: {
      fontFiles: [FONT, FONT_DISPLAY, FONT_MONO],
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Sans',
    },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

// Measure the ink box of a string once per (font, size, text) and cache it. Every position on
// the card is computed from these boxes instead of font-metric estimates:
//   x0/x1:  ink extent relative to the text x origin (letter-spacing included)
//   top:    ink height above the baseline
//   bottom: ink height below the baseline
const inkCache = new Map();
function measureText(str, size, fontName, fontFile, ls = 0) {
  const key = `${fontName}:${size}:${ls}:${str}`;
  if (inkCache.has(key)) return inkCache.get(key);
  const baseY = size * 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="${size * 3 + 40}">` +
    `<text x="10" y="${baseY}" font-family="${fontName}" font-size="${size}"${ls ? ` letter-spacing="${ls}"` : ''} fill="#fff">${esc(str)}</text></svg>`;
  const rendered = new Resvg(svg, {
    font: {
      fontFiles: [fontFile],
      loadSystemFonts: false,
      defaultFontFamily: fontName,
    },
  }).render();
  const px = rendered.pixels;
  const w = rendered.width;
  const h = rendered.height;
  let x0 = w;
  let x1 = -1;
  let y0 = h;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (px[(y * w + x) * 4 + 3] > 30) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const box = { w: x1 - x0 + 1 + ls * Math.max(0, str.length - 1), h: y1 - y0 + 1, x0: x0 - 10, x1: x1 - 10 + ls * Math.max(0, str.length - 1), top: baseY - y0, bottom: y1 - baseY };
  inkCache.set(key, box);
  return box;
}

// Riot rank emblems ship with a transparent margin baked into the PNG. Render
// the art once, scan its ink box, and return a crop rect so the emblem can fill
// its slot edge to edge. Only PNG art is cropped; anything else returns null
// and the caller falls back to the plain image element.
const iconCropCache = new Map();
async function iconCrop(dataUri) {
  if (iconCropCache.has(dataUri)) return iconCropCache.get(dataUri);
  let crop = null;
  try {
    const buf = Buffer.from(String(dataUri).split(',')[1], 'base64');
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buf.length > 24 && sig.compare(buf, 0, 8) === 0) {
      const aw = buf.readUInt32BE(16);
      const ah = buf.readUInt32BE(20);
      const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${aw}" height="${ah}">` +
        `<image xlink:href="${dataUri}" x="0" y="0" width="${aw}" height="${ah}"/></svg>`;
      const rendered = new Resvg(svg, { background: 'rgba(0,0,0,0)' }).render();
      const px = rendered.pixels;
      const w = rendered.width;
      const h = rendered.height;
      let x0 = w;
      let y0 = h;
      let x1 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (px[(y * w + x) * 4 + 3] > 12) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 >= x0 && y1 >= y0) crop = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, aw, ah };
    }
  } catch {
    crop = null;
  }
  iconCropCache.set(dataUri, crop);
  return crop;
}

// ---- Inventory render (test) --------------------------------------------------
// A VALORANT "COLLECTION"-style page: dark navy canvas, big Anton header, a
// weapon-skin grid on the left (rarity band from the content-tier icon), and a
// right-hand panel with owned player cards, gun buddies and sprays.
const INV_BG = '#0f1923';
const INV_PANEL = '#141e2c';
const INV_MUTED = '#8b93a5';

async function renderInventoryImage(details, opts = {}) {
  if (!details) return null;
  const skins = opts.skins || (details.skins && details.skins.items) || [];
  const cards = opts.cards || details.cards || [];
  const sprays = opts.sprays || details.sprays || [];
  const buddies = opts.buddies || details.buddies || [];
  if (!skins.length && !cards.length && !sprays.length && !buddies.length) return null;

  const skinList = skins.slice(0, opts.skinLimit || 200);
  const cardList = cards.slice(0, 24);
  const sprayList = sprays.slice(0, 84);
  const buddyList = buddies.slice(0, 84);

  // Page frame: 1400px wide; left tile grid (4 cols), right collection panel.
  const PAD = 30;
  const HEAD_Y = 148;
  const CW = 190;
  const CH = 214;
  const GAP = 14;
  const COLS = 4;
  const GRID_W = COLS * CW + (COLS - 1) * GAP; // 802
  const PANEL_X = PAD + GRID_W + 26; // 858
  const PANEL_W = 1400 - PANEL_X - PAD; // 512
  const PX = PANEL_X + 26;
  const TAILS = 40; // bottom breathing room

  // ---- geometry pass (pure arithmetic, no rendering yet) ----
  const gridRows = Math.max(1, Math.ceil(skinList.length / COLS));
  const gridBottom = HEAD_Y + gridRows * (CH + GAP) - GAP + TAILS;

  const cardW = 104;
  const cardCols = 4;
  const cardRows = Math.ceil(cardList.length / cardCols) || 0;
  const SECT_TOP = 44;
  const SECT_GAP = 34;
  const cardBlock = cardList.length ? SECT_TOP + cardRows * (cardW / 2 + 14) - 14 + SECT_GAP : 0;
  const sqSize = 56;
  const sqCols = 7;
  // 12 visual rows for buddies/sprays, with a "+N more" chip when truncated.
  const sqBlock = (list) => (list.length ? SECT_TOP + Math.min(12, Math.ceil(list.length / sqCols)) * (sqSize + 12) + SECT_GAP : 0);
  const panelsTopPad = 40;
  const panelContent = panelsTopPad + cardBlock + sqBlock(buddyList) + sqBlock(sprayList);
  const H = Math.max(gridBottom, HEAD_Y + panelContent + TAILS);
  const PANEL_H = H - HEAD_Y;

  // ---- artwork pass ----
  const [skinIcons, tierImgs, cardIcons, sprayIcons, buddyIcons] = await Promise.all([
    Promise.all(skinList.map((x) => (x.icon ? fetchIconData(x.icon) : null))),
    Promise.all(skinList.map((x) => (x.tier ? cachedIcon(tierIcon(x.tier)) : null))),
    Promise.all(cardList.map((c) => fetchIconData((c.art && c.art.wide) || c.icon))),
    Promise.all(sprayList.map((x) => fetchIconData(x.staticIcon || x.icon))),
    Promise.all(buddyList.map((x) => fetchIconData(x.icon))),
  ]);

  const name = String(details.name || 'Account');
  const level = details.level && details.level.level;

  // ---- tile clip paths (rarity bands clip to the tile's rounded corners) ----
  let clips = '';
  skinList.forEach((_, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cx = PAD + col * (CW + GAP);
    const cy = HEAD_Y + row * (CH + GAP);
    clips += `<clipPath id="tile${i}"><rect x="${cx}" y="${cy}" width="${CW}" height="${CH}" rx="12"/></clipPath>`;
  });

  let s = '';
  // Red accent block + big title, VALORANT style.
  s += `<rect x="${PAD}" y="34" width="14" height="86" fill="#ff4655"/>`;
  s += `<text x="${PAD + 34}" y="98" font-family="Anton" font-size="72" fill="#ffffff">COLLECTION</text>`;
  const who = `${name}${level ? `  ·  LEVEL ${level}` : ''}`;
  s += `<text x="1370" y="90" text-anchor="end" font-family="DejaVu Sans" font-size="24" fill="#e2e6ee" letter-spacing="2">${esc(who.toUpperCase())}</text>`;
  s += `<text x="1370" y="118" text-anchor="end" font-family="DejaVu Sans" font-size="16" fill="${INV_MUTED}">${esc(
    details.skins && details.skins.count != null ? `${details.skins.count} skins owned` : ''
  )}</text>`;

  // Left: skin tiles.
  skinList.forEach((item, i) => {
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    const cxq = PAD + col * (CW + GAP);
    const cy = HEAD_Y + row * (CH + GAP);
    s += `<rect x="${cxq}" y="${cy}" width="${CW}" height="${CH}" rx="12" fill="url(#cellbgInv)" stroke="#2a3446" stroke-width="1"/>`;
    if (skinIcons[i]) {
      s += `<image xlink:href="${skinIcons[i]}" x="${cxq + 12}" y="${cy + 14}" width="${CW - 24}" height="118" preserveAspectRatio="xMidYMid meet"/>`;
    }
    s += `<text x="${cxq + CW / 2}" y="${cy + CH - 46}" text-anchor="middle" font-family="DejaVu Sans" font-size="14" fill="#ffffff">${esc(fitName(item.name, 24))}</text>`;
    const wpn = String(item.weapon || item.category || 'WEAPON').toUpperCase();
    s += `<text x="${cxq + CW / 2}" y="${cy + CH - 27}" text-anchor="middle" font-family="DejaVu Sans" font-size="11" fill="${INV_MUTED}" letter-spacing="1">${esc(wpn)}</text>`;
    if (tierImgs[i]) {
      // Rarity band along the tile's bottom edge, from the tier's icon art.
      s += `<g clip-path="url(#tile${i})"><image xlink:href="${tierImgs[i]}" x="${cxq + 4}" y="${cy + CH - 26}" width="${CW - 8}" height="22" preserveAspectRatio="xMidYMid slice"/></g>`;
    }
  });

  // Right: owned cards / buddies / sprays in a Valorant collection panel.
  s += `<rect x="${PANEL_X}" y="${HEAD_Y}" width="${PANEL_W}" height="${PANEL_H}" rx="16" fill="${INV_PANEL}"/>`;
  let py = HEAD_Y + panelsTopPad;
  const section = (title, count) => {
    s += `<text x="${PX}" y="${py}" font-family="Anton" font-size="30" fill="#ffffff">${esc(title)}</text>`;
    if (count != null) {
      s += `<text x="${PANEL_X + PANEL_W - 26}" y="${py}" text-anchor="end" font-family="DejaVu Sans" font-size="18" fill="${INV_MUTED}">${esc(String(count))}</text>`;
    }
    py += 30;
  };

  if (cardList.length) {
    section('PLAYER CARDS', cards.length);
    cardIcons.forEach((ic, i) => {
      if (!ic) return;
      const col = i % cardCols;
      const row = Math.floor(i / cardCols);
      s += `<image xlink:href="${ic}" x="${PX + col * (cardW + 12)}" y="${py + row * (cardW / 2 + 14)}" width="${cardW}" height="${cardW / 2}" preserveAspectRatio="xMidYMid meet"/>`;
    });
    if (cards.length > cardList.length) {
      s += `<text x="${PX}" y="${py + cardRows * (cardW / 2 + 14) + 8}" font-family="DejaVu Sans" font-size="14" fill="${INV_MUTED}">+${cards.length - cardList.length} more</text>`;
    }
    py += cardRows * (cardW / 2 + 14) - 14 + SECT_GAP;
  }
  if (buddyList.length) {
    section('GUN BUDDIES', buddies.length);
    const maxRows = Math.min(12, Math.ceil(buddyList.length / sqCols));
    buddyIcons.forEach((ic, i) => {
      if (!ic || Math.floor(i / sqCols) >= maxRows) return;
      const col = i % sqCols;
      const row = Math.floor(i / sqCols);
      s += `<image xlink:href="${ic}" x="${PX + col * (sqSize + 12)}" y="${py + row * (sqSize + 12)}" width="${sqSize}" height="${sqSize}" preserveAspectRatio="xMidYMid meet"/>`;
    });
    if (buddies.length > maxRows * sqCols) {
      s += `<text x="${PX}" y="${py + maxRows * (sqSize + 12) + 4}" font-family="DejaVu Sans" font-size="14" fill="${INV_MUTED}">+${buddies.length - maxRows * sqCols} more</text>`;
    }
    py += maxRows * (sqSize + 12) + SECT_GAP;
  }
  if (sprayList.length) {
    section('SPRAYS', sprays.length);
    const maxRows = Math.min(12, Math.ceil(sprayList.length / sqCols));
    sprayIcons.forEach((ic, i) => {
      if (!ic || Math.floor(i / sqCols) >= maxRows) return;
      const col = i % sqCols;
      const row = Math.floor(i / sqCols);
      s += `<image xlink:href="${ic}" x="${PX + col * (sqSize + 12)}" y="${py + row * (sqSize + 12)}" width="${sqSize}" height="${sqSize}" preserveAspectRatio="xMidYMid meet"/>`;
    });
    if (sprays.length > maxRows * sqCols) {
      s += `<text x="${PX}" y="${py + maxRows * (sqSize + 12) + 4}" font-family="DejaVu Sans" font-size="14" fill="${INV_MUTED}">+${sprays.length - maxRows * sqCols} more</text>`;
    }
    py += maxRows * (sqSize + 12) + SECT_GAP;
  }

  const defs =
    `<defs>` +
    clips +
    `<radialGradient id="cellbgInv" cx="50%" cy="38%" r="80%"><stop offset="0%" stop-color="#232d3f"/><stop offset="100%" stop-color="#161d29"/></radialGradient></defs>`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1400" height="${H}">` +
    defs +
    `<rect x="0" y="0" width="1400" height="${H}" fill="${INV_BG}"/>` +
    `${s}</svg>`;

  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT, FONT_DISPLAY], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  });
  return resvg.render().asPng();
}

// ---- Owned-items grid (/collection) ------------------------------------------
// Renders owned items (no prices) using the shop grid cell style. Placeholder
// cells are NOT drawn, so the last row stays left-aligned. Sections add Anton
// mini-title rows between groups - the "smaller titles" for skins/accessories.
async function renderOwnedGrid(opts = {}) {
  const sections = (opts.sections || [{ title: opts.title || null, items: opts.items || [] }]).filter(
    (sec) => sec && Array.isArray(sec.items) && sec.items.length
  );
  if (!sections.length) return null;

  const items = sections.flatMap((sec) => sec.items);
  const limit = opts.limit || 96;
  const cols = opts.cols || 2;
  const CELL_W = 560;
  const CELL_H = 236;
  const ICON_W = 510;
  const ICON_H = 160;
  const GAP = 18;
  const TIER_SIZE = 60;
  const TIER_MARGIN = 10;
  const TITLE_H = 74; // page title row (Anton)
  const SECTION_H = 52; // per-section mini-title row

  const icons = await Promise.all(items.map((i) => (i && (i.staticIcon || i.icon) ? fetchIconData(i.staticIcon || i.icon) : null)));
  const tierImgs = await Promise.all(
    items.map((i) => (i && i.tier ? cachedIcon(tierIcon(i.tier)) : null))
  );

  // ---- geometry pass ----
  let total = 0;
  const rects = []; // per-section: {title?, originY}
  let y = 0;
  if (opts.title) y += TITLE_H;
  for (const sec of sections) {
    const secItems = sec.items.slice(0, Math.max(0, limit - items.length + sec.items.length));
    if (!secItems.length) continue;
    if (sec.title) y += SECTION_H;
    const secStart = y;
    secItems.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      if (col === 0) rects.push({ cx: PAD + 0, cy: y + row * (CELL_H + GAP) });
    });
    const rows = Math.ceil(secItems.length / cols);
    y += rows * (CELL_H + GAP);
    rects.push({ sectionTitleY: secStart, items: secItems, rows, sectionIndex: rects.length });
    void total;
  }
  void total;

  // Simplest reliable approach: do a second rendering pass with a running (cx, cy)
  // cursor instead of the rect bookkeeping above.
  let svgCells = '';
  let svgExtras = '';
  let curY = 0;
  if (opts.title) {
    svgExtras += `<text x="${PAD}" y="${46 + curY}" font-family="Anton" font-size="52" fill="#ffffff" letter-spacing="2">${esc(String(opts.title).toUpperCase())}</text>`;
    curY += TITLE_H;
  }
  for (const sec of sections) {
    const secItems = sec.items.slice(0, limit);
    if (!secItems.length) continue;
    if (sec.title) {
      svgExtras += `<text x="${PAD}" y="${curY + 34}" font-family="Anton" font-size="30" fill="#e2e6ee" letter-spacing="2">${esc(String(sec.title).toUpperCase())}</text>`;
      curY += SECTION_H;
    }
    secItems.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = PAD + col * (CELL_W + GAP);
      const cy = curY + row * (CELL_H + GAP);
      const idx = items.indexOf(item); // unique per section loop
      svgCells += `<rect x="${cx}" y="${cy}" width="${CELL_W}" height="${CELL_H}" rx="16" fill="url(#cellbg)"/>`;
      if (icons[idx]) {
        svgCells += `<image xlink:href="${icons[idx]}" x="${cx + (CELL_W - ICON_W) / 2}" y="${cy + 18}" width="${ICON_W}" height="${ICON_H}" preserveAspectRatio="xMidYMid meet"/>`;
      }
      svgCells += `<text x="${cx + CELL_W / 2}" y="${cy + 212}" text-anchor="middle" font-family="DejaVu Sans" font-size="26" fill="#ffffff">${esc(fitName(item.name))}</text>`;
      if (tierImgs[idx]) {
        svgCells += `<image xlink:href="${tierImgs[idx]}" x="${cx + CELL_W - TIER_SIZE - TIER_MARGIN}" y="${cy + CELL_H - TIER_SIZE - TIER_MARGIN}" width="${TIER_SIZE}" height="${TIER_SIZE}" preserveAspectRatio="xMidYMid meet"/>`;
      }
    });
    curY += Math.ceil(secItems.length / cols) * (CELL_H + GAP) + 8;
  }
  void rects;

  const W = PAD * 2 + CELL_W * cols + GAP * (cols - 1);
  const H = Math.max(curY, TITLE_H);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">` +
    cellDefs() +
    `${svgExtras}${svgCells}</svg>`;

  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT, FONT_DISPLAY], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  });
  return resvg.render().asPng();
}

module.exports = { renderSkinGrid, renderAnimatedSkinGrid, renderWalletImage, renderBundleGrid, renderBundleMedia, renderRankImage, renderCollectionImage, renderInventoryImage, renderOwnedGrid, shortNum, GRID_CACHE_VERSION };
