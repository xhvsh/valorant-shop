'use strict';

// The Agent ID card of the /mastery command, drawn the way the dashboard's Agent mastery tab draws
// it (website/styles.css, .mas-board): the equipped background inside the level frame, the agent
// in its pose rising over the frame's top edge, the agent's icon with the Riot ID, the lifetime
// level and the agent's name bottom left, and the three stat slots down the right. Every size is
// a share of the board's width, as in the page. The pictures are read from assets/mastery (made by
// scripts/build-mastery-art.py) so the bot never waits on the wiki.

const fs = require('node:fs');
const path = require('node:path');
const { Resvg } = require('@resvg/resvg-js');

const ASSETS = path.join(__dirname, '..', 'assets');
const ART = path.join(ASSETS, 'mastery');
const FONT = path.join(ASSETS, 'DejaVuSans.ttf');
const FONT_DISPLAY = path.join(ASSETS, 'Anton-Regular.ttf');

// What each stat id is called on the card (same names as the dashboard).
const STAT_LABELS = {
  bloomline_short_level_reached: 'Act Lvl 10 achieved',
  match_aces: 'Aces',
  match_assists: 'Assists',
  match_clutches: 'Clutches',
  match_damage: 'Damage',
  match_first_bloods: 'First bloods',
  match_headshot_pct: 'Headshot %',
  match_kd: 'K/D',
  match_kills: 'Kills',
  match_match_mvps: 'MVPs',
  match_playtime_hours: 'Hours played',
  match_win_pct: 'Win rate',
  match_wins: 'Games won',
};

function statValue(s) {
  const v = Number(s.value) || 0;
  const n = (x) => Math.round(x).toLocaleString('en-US');
  if (/_pct$/.test(s.key)) return `${(Math.round(v * 10) / 10).toLocaleString('en-US')}%`;
  if (s.key === 'match_kd') return String(Math.round(v * 100) / 100);
  if (s.key === 'match_playtime_hours') return `${(Math.round(v * 10) / 10).toLocaleString('en-US')}h`;
  return n(v);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const artKey = (name) => String(name).replace(/[^A-Za-z0-9]/g, '');
const BG_FILE = { Default: 'default', Role: 'role', ValLogo: 'val', Lore: 'lore' };

// --- small colour helpers -------------------------------------------------------------------
function rgb(hex) {
  const m = /^#?([0-9a-f]{6})/i.exec(String(hex || ''));
  const n = m ? parseInt(m[1], 16) : 0x33406b;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toCss = (c, a) => (a == null ? `rgb(${c.map(Math.round).join(',')})` : `rgba(${c.map(Math.round).join(',')},${a})`);
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// The accent: the most vivid of the agent's own colours, lightened (as the dashboard does).
function accentOf(colors, lighten = 0.6) {
  let best = null;
  for (const c of colors || []) {
    const [r, g, b] = rgb(c);
    const score = Math.max(r, g, b) - Math.min(r, g, b) + Math.max(r, g, b) * 0.4;
    if (!best || score > best.score) best = { c: [r, g, b], score };
  }
  return best ? mix(best.c, [255, 255, 255], lighten) : [233, 236, 245];
}

// The agent's own colour as a number, for a message's accent bar.
function agentColor(colors) {
  const [r, g, b] = accentOf(colors, 0.2).map(Math.round);
  return (r << 16) | (g << 8) | b;
}

// --- pictures ---------------------------------------------------------------------------------
function dataUri(file, mime) {
  try {
    return `data:${mime};base64,${fs.readFileSync(path.join(ART, file)).toString('base64')}`;
  } catch {
    return null;
  }
}

let poseDims = null;
function poseSize(key) {
  if (!poseDims) {
    try {
      poseDims = JSON.parse(fs.readFileSync(path.join(ART, 'poses.json'), 'utf8'));
    } catch {
      poseDims = {};
    }
  }
  return poseDims[key] || [700, 636];
}

// The standard pose is the agent's full portrait from valorant-api; PNG size is in its header.
const portraitCache = new Map();
async function portrait(url) {
  if (!url) return null;
  if (portraitCache.has(url)) return portraitCache.get(url);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const out = { uri: `data:image/png;base64,${buf.toString('base64')}`, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    portraitCache.set(url, out);
    return out;
  } catch {
    return null;
  }
}

async function remoteIcon(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return `data:image/png;base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

// --- the card -----------------------------------------------------------------------------------
const W = 820;
const CQ = W / 100;
const BOARD_H = (W * 3) / 5;
const TOP = 148; // room above the board for the pose to rise into
const H = TOP + BOARD_H;
const q = (n) => n * CQ;

// The frame is a 9-slice picture (slice 60 / 190 of 452 x 160, drawn 22.1% / 42.04% of the board
// thick), so each of its eight pieces is cut out of the source and stretched on its own.
function frameSvg(uri) {
  if (!uri) return '';
  const SW = 452, SH = 160, SV = 60, SX = 190;
  const bw = W * 0.4204, bh = BOARD_H * 0.221;
  const x = [0, bw, W - bw, W];
  const y = [TOP, TOP + bh, TOP + BOARD_H - bh, TOP + BOARD_H];
  const sx = [0, SX, SW - SX, SW];
  const sy = [0, SV, SH - SV, SH];
  let out = '';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      if (r === 1 && c === 1) continue;
      out +=
        `<svg x="${x[c]}" y="${y[r]}" width="${x[c + 1] - x[c]}" height="${y[r + 1] - y[r]}" viewBox="${sx[c]} ${sy[r]} ${sx[c + 1] - sx[c]} ${sy[r + 1] - sy[r]}" preserveAspectRatio="none">` +
        `<image xlink:href="${uri}" x="0" y="0" width="${SW}" height="${SH}"/></svg>`;
    }
  }
  return `<g opacity=".92">${out}</g>`;
}

// The VALORANT mark (svgrepo "valorant-logo-play-2"), 32 x 32.
const V_MARK = 'M19.8 26.1h-.2c-2.4 0-4.8 0-7.2 0-.3 0-.5-.1-.6-.3-2.5-3.2-5.1-6.3-7.6-9.5C4.1 16.1 4 16 4 15.8c0-3.1 0-6.1 0-9.2 0-.1 0-.2.1-.2h.1c5.2 6.5 10.4 13 15.5 19.5 0 0 0 .1.1.1zM27.8 16.3c-.7.9-1.5 1.8-2.2 2.8-.2.2-.4.3-.6.3-2.4 0-4.8 0-7.1 0-.1 0-.2-.1-.1-.2 0 0 0-.1.1-.1 2.4-3 4.7-5.9 7.1-8.9 1-1.2 2-2.5 2.9-3.7 0-.1.1-.1.2-.1h.1c0 .1 0 .1 0 .2 0 3 0 6.1 0 9.1 0 .3-.1.5-.2.6z';

function slotSvg(i, st, c1, accent) {
  const w = q(15.6), h = q(13);
  const x = W - q(6.6) - w;
  const y = TOP + q(7.4) + i * (h + q(2.6));
  const bot = mix(rgb(c1), [11, 15, 26], 0.2);
  let s =
    `<defs><linearGradient id="slot${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(6,9,18)" stop-opacity=".94"/><stop offset="1" stop-color="${toCss(bot)}"/></linearGradient></defs>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#slot${i})"/>` +
    `<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" fill="none" stroke="rgba(255,255,255,.05)"/>`;
  // Corner brackets round the slot, in the agent's colour.
  const o = q(0.7), L = q(1.6), sw = Math.max(1, q(0.18));
  const bc = toCss(accent, 0.75);
  const x0 = x - o, y0 = y - o, x1 = x + w + o, y1 = y + h + o;
  s += `<path d="M${x0} ${y0 + L}V${y0}H${x0 + L} M${x1 - L} ${y0}H${x1}V${y0 + L} M${x0} ${y1 - L}V${y1}H${x0 + L} M${x1 - L} ${y1}H${x1}V${y1 - L}" fill="none" stroke="${bc}" stroke-width="${sw}"/>`;
  const cx = x + w / 2;
  if (st) {
    const vs = Math.max(13, q(3.6));
    const valY = y + h / 2 + vs * 0.1;
    s += `<text x="${cx}" y="${valY}" text-anchor="middle" font-family="Anton" font-size="${vs * 1.05}" fill="#fff">${esc(statValue(st))}</text>`;
    const lbl = String(STAT_LABELS[st.key] || st.key).toUpperCase();
    s += `<text x="${cx}" y="${valY + q(2.9)}" text-anchor="middle" font-family="DejaVu Sans" font-size="${Math.max(8, q(1.15))}" letter-spacing="${(Math.max(8, q(1.15)) * 0.1).toFixed(2)}" fill="rgba(225,230,245,.7)">${esc(lbl)}</text>`;
  } else {
    const m = q(5);
    s += `<g transform="translate(${cx - m / 2} ${y + h / 2 - m / 2}) scale(${m / 32})" fill="rgba(255,255,255,.85)"><path d="${V_MARK}"/></g>`;
  }
  return s;
}

// agent: { name, icon, portrait, colors }, equipped: { background, frame, pose }, stats: [{ key, value }]
async function renderMasteryCard({ agent, equipped, lifetime, riotId, stats }) {
  const eq = equipped || { background: 'Default', frame: 1, pose: 'Default' };
  const key = artKey(agent.name);
  const colors = agent.colors && agent.colors.length ? agent.colors : ['#33406b', '#0e1428'];
  const c1 = colors[0];
  const accent = accentOf(colors);
  const accentCss = toCss(accent);
  const c1MixDiamond = mix(rgb(c1), [11, 15, 26], 0.3);

  const bgUri = dataUri(`bg-${BG_FILE[eq.background] || 'default'}-${key}.jpg`, 'image/jpeg') || dataUri(`bg-default-${key}.jpg`, 'image/jpeg');
  const frameUri = dataUri(`frame-${Math.min(4, Math.max(1, Number(eq.frame) || 1))}.png`, 'image/png');
  const mastery = eq.pose === 'HighTier' ? dataUri(`pose-${key}.webp`, 'image/webp') : null;
  const [poseUri, pw, ph] = await (async () => {
    if (mastery) {
      const [w, h] = poseSize(key);
      return [mastery, w, h];
    }
    const p = await portrait(agent.portrait);
    return p ? [p.uri, p.w, p.h] : [null, 1, 1];
  })();
  const iconUri = await remoteIcon(agent.icon);

  const bx = q(3.6), by = TOP + q(3.3), bw = W - 2 * bx, bh = BOARD_H - 2 * q(3.3);
  const cut = q(2.2);
  const octagon = `M${bx + cut} ${by}H${bx + bw - cut}L${bx + bw} ${by + cut}V${by + bh - cut}L${bx + bw - cut} ${by + bh}H${bx + cut}L${bx} ${by + bh - cut}V${by + cut}Z`;

  let s = `<defs><clipPath id="bgclip"><path d="${octagon}"/></clipPath>` +
    `<clipPath id="poseclip"><rect x="${bx}" y="0" width="${bw}" height="${TOP + BOARD_H - q(3.3)}"/></clipPath>` +
    `<linearGradient id="bgshade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgb(5,8,16)" stop-opacity=".45"/><stop offset=".38" stop-color="rgb(5,8,16)" stop-opacity="0"/></linearGradient>` +
    `<linearGradient id="bgbase" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121a2c"/><stop offset="1" stop-color="#0a0f1b"/></linearGradient>` +
    `<linearGradient id="namebar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${toCss(mix(rgb(c1), [6, 9, 18], 0.3))}"/><stop offset="1" stop-color="${toCss(mix(rgb(c1), [6, 9, 18], 0.3), 0)}"/></linearGradient>` +
    `<filter id="poseshadow" x="-10%" y="-10%" width="120%" height="120%"><feDropShadow dx="0" dy="${q(1)}" stdDeviation="${q(1.2)}" flood-color="#000" flood-opacity=".45"/></filter></defs>`;

  s += `<g clip-path="url(#bgclip)"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#bgbase)"/>` +
    (bgUri ? `<image xlink:href="${bgUri}" x="${bx}" y="${by}" width="${bw}" height="${bh}" preserveAspectRatio="xMidYMid slice"/>` : '') +
    `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="url(#bgshade)"/></g>`;
  s += frameSvg(frameUri);

  if (poseUri) {
    // 112% of the board wide, centred a little left, hanging from just above the pose box's top.
    const iw = q(112);
    const ih = (iw * ph) / pw;
    const ix = q(50) - 0.52 * iw;
    const iy = TOP - q(19.5);
    s += `<g clip-path="url(#poseclip)"><g filter="url(#poseshadow)"><image xlink:href="${poseUri}" x="${ix}" y="${iy}" width="${iw}" height="${ih}" preserveAspectRatio="none"/></g></g>`;
  }

  // Bottom left: the agent's icon, the Riot ID, then the lifetime level and the agent's name.
  const idX = q(7.2);
  const idBottom = TOP + BOARD_H - q(8.6);
  const diamond = q(6.4);
  const rowTop = idBottom - diamond;
  const rowMid = rowTop + diamond / 2;
  const nameSize = Math.max(18, q(6));
  const riotSize = Math.max(10, q(1.85));
  const riotBottom = rowTop - q(1) - q(0.4);
  const riotTop = riotBottom - riotSize * 1.2;
  const cardSize = q(11);
  const cardBottom = riotTop - q(1);
  const cardTop = cardBottom - cardSize;
  if (iconUri) {
    s += `<g><rect x="${idX}" y="${cardTop}" width="${cardSize}" height="${cardSize}" fill="#1a2036"/>` +
      `<image xlink:href="${iconUri}" x="${idX}" y="${cardTop}" width="${cardSize}" height="${cardSize}" preserveAspectRatio="xMidYMid slice"/>` +
      `<rect x="${idX + 0.5}" y="${cardTop + 0.5}" width="${cardSize - 1}" height="${cardSize - 1}" fill="none" stroke="rgba(255,255,255,.28)" stroke-width="${Math.max(1, q(0.2))}"/></g>`;
  }
  const [game, tag] = String(riotId || '').split('#');
  s += `<text x="${idX}" y="${riotTop + riotSize * 0.95}" font-family="DejaVu Sans" font-weight="bold" font-size="${riotSize}" fill="#fff">${esc(game || '')}` +
    (tag ? `<tspan font-weight="normal" fill="rgba(220,225,240,.55)">#${esc(tag)}</tspan>` : '') + `</text>`;

  const nameX = idX + diamond + q(1.2);
  const nameText = String(agent.name).toUpperCase();
  const nameW = nameText.length * nameSize * 0.52;
  s += `<rect x="${idX + q(3)}" y="${rowMid - q(3.1)}" width="${nameX - idX - q(3) + nameW + q(7)}" height="${q(6.2)}" fill="url(#namebar)"/>`;
  const dd = diamond * 0.7;
  s += `<g transform="translate(${idX + diamond / 2} ${rowMid}) rotate(45)"><rect x="${-dd / 2}" y="${-dd / 2}" width="${dd}" height="${dd}" fill="${toCss(c1MixDiamond)}" stroke="${accentCss}" stroke-width="${Math.max(1.5, q(0.35))}"/></g>`;
  s += `<text x="${idX + diamond / 2}" y="${rowMid + Math.max(10, q(2.2)) * 0.36}" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="${Math.max(10, q(2.2))}" fill="#fff">${esc(String(lifetime))}</text>`;
  s += `<text x="${nameX}" y="${rowMid + nameSize * 0.36}" font-family="Anton" font-size="${nameSize}" fill="#f3f1ea">${esc(nameText)}</text>`;

  for (let i = 0; i < 3; i++) s += slotSvg(i, stats && stats[i], c1, accent);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${s}</svg>`;
  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT, FONT_DISPLAY], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
    background: 'rgba(0,0,0,0)',
  });
  return resvg.render().asPng();
}

module.exports = { renderMasteryCard, STAT_LABELS, accentOf, agentColor };
