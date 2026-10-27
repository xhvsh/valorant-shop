'use strict';
const { CURRENCY_LABEL } = require('../items');
const { dominantColor } = require('../image-color');

const COLORS = {
  main: 0xff4655,
  night: 0x8b5cf6,
  fallback: 0x9aa0a6,
};

// The easter-egg buddy (see EASTER_EGG_BUDDY_ID in items.js) and the custom
// emoji shown beside the /collection footer for people who own it.
const RIOT_GUNBUDDY_ID = 'a57aa3d0-4ad0-b06a-6c54-338cb3ea6b41';
const RIOT_GUNBUDDY_EMOJI = process.env.EMOJI_RIOT_GUNBUDDY || '<:riotgunbuddy:1564071453974855701>';

function ownsRiotGunbuddy(details) {
  const buddies = (details && details.buddies) || [];
  return buddies.some((b) => b && (String(b.id).toLowerCase() === RIOT_GUNBUDDY_ID || b.name === 'Riot Gunbuddy'));
}

const V2 = 1 << 15;
const EPHEMERAL = 1 << 6;

function fmtLeft(ms) {
  if (!ms || ms <= 0) return 'soon';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtNum(n) {
  if (n == null) return '?';
  return Number(n).toLocaleString('en-US');
}

function shopFromLine(store) {
  const end = store && store.daily && store.daily.expiresAt;
  const start = end ? end - 24 * 60 * 60 * 1000 : Date.now();
  return `-# Shop from <t:${Math.floor(start / 1000)}:D>`;
}

function text(content) {
  return { type: 10, content };
}

function thumb(url) {
  return { type: 11, media: { url } };
}

function mediaItem(url, spoiler) {
  return { media: { url }, spoiler: Boolean(spoiler) };
}

function gallery(url, spoiler) {
  return { type: 12, items: [mediaItem(url, spoiler)] };
}

function container(color, components) {
  return { type: 17, accent_color: color, components };
}

function section(content, accessory) {
  if (!accessory) return text(content);
  return { type: 9, components: [text(content)], accessory };
}

function walletText(store) {
  const w = (store && store.wallet) || {};
  const vp = CURRENCY_LABEL.vp || 'VP';
  const rp = CURRENCY_LABEL.rp || 'RP';
  const kc = CURRENCY_LABEL.kc || 'KC';
  return `${vp} **${fmtNum(w.vp)}**  ·  ${rp} **${fmtNum(w.rp)}**  ·  ${kc} **${fmtNum(w.kc)}**`;
}

function dailyFooter(manageUrl) {
  const where = manageUrl ? `[Manage accounts and alerts](${manageUrl})` : 'the website';
  return text(`-# Automated daily DM · ${where}`);
}

function alertFooter(manageUrl) {
  const where = manageUrl ? `[Manage accounts and alerts](${manageUrl})` : 'the website';
  return text(`-# Automated alert · ${where}`);
}

// Short status reply (errors, empty shops) in the same boxed style as the real
// messages. Private notices are flagged so the follow-up sender posts them
// ephemerally (only the user who ran the command sees them).
function buildNotice(content, opts = {}) {
  const payload = { flags: V2, components: [container(COLORS.main, [text(content)])] };
  if (opts.private) payload.private = true;
  return payload;
}

function buildShopMessage(store, name, gridUrl, walletUrl, opts = {}) {
  const lines = [`## ${name ? `${name}'s shop` : 'Shop'}`];
  const end = store && store.daily && store.daily.expiresAt;
  if (end) lines.push(`Resets <t:${Math.floor(end / 1000)}:R>`);
  lines.push(shopFromLine(store));
  const parts = [section(lines.join('\n'), walletUrl ? thumb(walletUrl) : null)];
  if (!walletUrl) parts.push(text(walletText(store)));
  if (gridUrl) parts.push(gallery(gridUrl, false));
  if (opts && opts.daily && opts.footer !== false) parts.push(dailyFooter(opts.manageUrl));
  return { flags: V2, components: [container(COLORS.main, parts)] };
}

function buildAccessoryMessage(store, name, gridUrl, walletUrl) {
  const ks = (store && store.kingdomShop) || {};
  const lines = [`## ${name ? `${name}'s accessories` : 'Accessories'}`];
  // Riot only reports how long is left, not how long the rotation lasts, so show
  // the exact end instead of guessing a start date.
  if (ks.expiresAt) {
    const end = Math.floor(ks.expiresAt / 1000);
    lines.push(`Resets <t:${end}:R>`);
    lines.push(`-# Rotates <t:${end}:f>`);
  }
  const parts = [section(lines.join('\n'), walletUrl ? thumb(walletUrl) : null)];
  if (!walletUrl) parts.push(text(walletText(store)));
  if (gridUrl) parts.push(gallery(gridUrl, false));
  return { flags: V2, components: [container(COLORS.main, parts)] };
}

function buildNightMarketMessage(store, name, gridUrl, walletUrl) {
  const nm = store && store.nightMarket;
  if (!nm || !nm.items || !nm.items.length) return null;
  const lines = [`## ${name ? `${name}'s night market` : 'Night Market'}`];
  if (nm.expiresAt) lines.push(`Night Market leaves <t:${Math.floor(nm.expiresAt / 1000)}:R>`);
  const parts = [section(lines.join('\n'), walletUrl ? thumb(walletUrl) : null)];
  if (!walletUrl) parts.push(text(walletText(store)));
  if (gridUrl) parts.push(gallery(gridUrl, true));
  return { flags: V2, components: [container(COLORS.night, parts)] };
}

// Heading with the Riot ID, then the rendered rank card. The accent bar takes
// the tier colour (white tiers like Unranked fall back to grey).
function buildRankMessage(details, name, cardUrl) {
  const parts = [text(`## ${name ? `${name}'s rank` : 'Rank'}`)];
  if (cardUrl) parts.push(gallery(cardUrl, false));
  const m = /^#?([0-9a-fA-F]{6})/.exec(String((details && details.rank && details.rank.color) || ''));
  const hex = m ? parseInt(m[1], 16) : null;
  const color = hex != null && hex !== 0xffffff ? hex : COLORS.fallback;
  return { flags: V2, components: [container(color, parts)] };
}

// Column data for /collection, shared by the stat card renderer and the plain
// text fallback.
function collectionColumns(details) {
  const s = (details && details.skins) || {};
  const k = s.kinds || { standard: 0, agent: 0, limited: 0, battlepass: 0 };
  const count = (key) => (Array.isArray(details && details[key]) ? details[key].length : 0);
  const accessories = [
    { label: 'Sprays', value: count('sprays') },
    { label: 'Flexes', value: count('flexes') },
    { label: 'Gunbuddies', value: count('buddies') },
    { label: 'Player cards', value: count('cards') },
    { label: 'Titles', value: count('titles') },
  ];
  return [
    {
      label: 'Weapon skins',
      total: s.count || 0,
      rows: [
        { label: 'Standard', value: k.standard || 0 },
        { label: 'Agent', value: k.agent || 0 },
        { label: 'Limited', value: k.limited || 0 },
        { label: 'Battle pass', value: k.battlepass || 0 },
      ],
    },
    { label: 'Accessories', total: accessories.reduce((a, r) => a + r.value, 0), rows: accessories },
  ];
}

// Same shape as /rank: a heading with the Riot ID, then the rendered stat card
// (columns side by side). Falls back to stacked text if the card failed.
function buildCollectionMessage(details, name, cardUrl) {
  const heading = `## ${name ? `${name}'s collection` : 'Collection'}`;
  // Plain text right under the title, not a small footer.
  const owns = ownsRiotGunbuddy(details) ? `\n${RIOT_GUNBUDDY_EMOJI} This user owns a Riot Gunbuddy` : '';
  const parts = [text(heading + owns)];
  if (cardUrl) {
    parts.push(gallery(cardUrl, false));
  } else {
    for (const col of collectionColumns(details)) {
      const lines = [`**${col.label}** (${fmtNum(col.total)})`, ...col.rows.map((r) => `${r.label}: ${fmtNum(r.value)}`)];
      parts.push(text(lines.join('\n')));
    }
  }
  return { flags: V2, components: [container(COLORS.main, parts)] };
}

function buildBundleMessage(bundles, opts = {}) {
  const selectedId = opts.selectedId != null ? String(opts.selectedId) : '';
  const list = (bundles || []).slice(0, 25);
  const sel = list.find((b) => b && String(b.id) === selectedId) || list[0];
  const components = [];
  if (sel) {
    const vpLabel = CURRENCY_LABEL.vp || 'VP';
    const lines = [];
    if (sel.before != null && sel.after != null) {
      lines.push(`**${fmtNum(sel.after)} ${vpLabel}** ~~${fmtNum(sel.before)} ${vpLabel}~~${sel.percent ? ` *(-${sel.percent}%)*` : ''}`);
    } else if (sel.after != null) {
      lines.push(`**${fmtNum(sel.after)} ${vpLabel}**`);
    }
    if (sel.leavesAt) lines.push(`Leaves the shop <t:${Math.floor(sel.leavesAt / 1000)}:R>`);
    const nm = sel.name || 'Bundle';
    const title = /Bundle$/i.test(nm) ? nm : `${nm} Bundle`;
    const parts = [section(`## ${title}\n${lines.join('\n')}`)];
    if (sel.art) parts.push(gallery(sel.art, false));
    const gridUrl = opts.imageRefs && opts.imageRefs[sel.id];
    if (gridUrl) parts.push(gallery(gridUrl, false));
    if (opts.footer) parts.push(opts.footer);
    const accent = opts.accentColor != null ? opts.accentColor : COLORS.main;
    components.push(container(accent, parts));
  }
  for (const row of bundleComponents(list, { selectedId: sel ? sel.id : '' })) components.push(row);
  return { flags: V2, components };
}

async function bundleAccentColor(art) {
  const color = await dominantColor(art).catch(() => null);
  return color != null ? color : COLORS.main;
}

function bundleComponents(bundles, opts = {}) {
  const selectedId = opts.selectedId != null ? String(opts.selectedId) : '';
  const list = (bundles || []).slice(0, 25);
  const rows = [];
  if (list.length > 1) {
    rows.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: 'bundle_select',
          placeholder: 'Choose a bundle',
          min_values: 1,
          max_values: 1,
          options: list.map((b) => ({
            label: String(b.name || 'Bundle').slice(0, 100),
            value: String(b.id),
            default: String(b.id) === selectedId,
          })),
        },
      ],
    });
  }
  return rows;
}

module.exports = {
  buildNotice,
  EPHEMERAL,
  buildShopMessage,
  buildAccessoryMessage,
  buildNightMarketMessage,
  buildBundleMessage,
  bundleAccentColor,
  buildRankMessage,
  buildCollectionMessage,
  collectionColumns,
  ownsRiotGunbuddy,
  bundleComponents,
  dailyFooter,
  alertFooter,
  fmtLeft,
};