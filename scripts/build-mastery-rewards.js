'use strict';

// Builds src/mastery-rewards.json: every agent's Agent Mastery rewards, tier by tier, in the order
// the game lists them. The tiers and item names come from each agent's wiki page (the API has no
// list of them); sprays, cards, titles, buddies and skins are then matched by name to
// valorant-api so the page can draw their real art and tell which ones an account owns.
//
//   node scripts/build-mastery-rewards.js

const fs = require('fs');
const path = require('path');

const WIKI = 'https://wiki.playvalorant.com/en-us';
const API = 'https://valorant-api.com/v1';
const OUT = path.join(__dirname, '..', 'src', 'mastery-rewards.json');

async function json(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'val-shops mastery rewards builder' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const decode = (s) => String(s)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&#0?39;|&apos;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, '&')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Wiki file name from a thumb or full image src.
function fileOf(src) {
  const m = /\/images\/(?:thumb\/)?([^/?]+)/.exec(src || '');
  return m ? decodeURIComponent(m[1]) : null;
}

function tiersFrom(html) {
  const tiers = [];
  const tables = html.split(/<table/).slice(1);
  for (const t of tables) {
    const cap = /<caption>([\s\S]*?)<\/caption>/.exec(t);
    const at = cap && /Lifetime Level\s*(\d+)/.exec(decode(cap[1]));
    if (!at) continue;
    const items = [];
    for (const row of t.split(/<tr>/).slice(2)) {
      const cells = row.split(/<td[^>]*>/).slice(1).map((c) => c.split(/<\/td>/)[0]);
      if (cells.length < 4) continue;
      const img = /<img[^>]+src="([^"]+)"/.exec(cells[0]);
      const audio = /<source src="([^"]+\.mp3)/.exec(cells[0]);
      const name = decode(cells[1]);
      const category = decode(cells[2]);
      const cost = Number(decode(cells[3]).replace(/\D/g, '')) || 0;
      const item = { name, category, cost };
      const file = img && fileOf(img[1]);
      if (file && !/^(Agent_Mastery_(Stat|Quote|Frame)_Icon|Player_Title_image)\.png$/.test(file)) item.wiki = file;
      if (audio) item.audio = fileOf(audio[1]);
      items.push(item);
    }
    if (items.length) tiers.push({ at: Number(at[1]), items });
  }
  return tiers.sort((a, b) => a.at - b.at);
}

async function main() {
  const [agents, sprays, cards, titles, buddies, weapons] = await Promise.all([
    json(`${API}/agents?isPlayableCharacter=true`),
    json(`${API}/sprays`),
    json(`${API}/playercards`),
    json(`${API}/playertitles`),
    json(`${API}/buddies`),
    json(`${API}/weapons`),
  ]);
  const index = (list, key = 'displayName') => new Map(list.map((x) => [norm(x[key]), x]));
  const spraysBy = index(sprays.data);
  const cardsBy = index(cards.data);
  const titlesBy = index(titles.data);
  const buddiesBy = index(buddies.data);
  const skinsBy = index(weapons.data.flatMap((w) => w.skins));

  const out = {};
  for (const a of agents.data.sort((x, y) => x.displayName.localeCompare(y.displayName))) {
    // The wiki titles KAY/O's page "KAYO".
    const page = a.displayName.replace(/\//g, '');
    let parsed;
    try {
      parsed = await json(`${WIKI}/api.php?action=parse&format=json&formatversion=2&prop=text&page=${encodeURIComponent(page)}`);
    } catch (err) {
      console.warn(`skip ${a.displayName}: ${err.message}`);
      continue;
    }
    const tiers = tiersFrom((parsed.parse && parsed.parse.text) || '');
    for (const tier of tiers) {
      for (const it of tier.items) {
        const c = it.category.toLowerCase();
        if (c === 'sprays') {
          const s = spraysBy.get(norm(it.name));
          it.kind = 'spray';
          if (s) Object.assign(it, { id: s.uuid, icon: s.fullTransparentIcon || s.displayIcon, anim: s.animationGif || undefined });
        } else if (c === 'player cards') {
          const s = cardsBy.get(norm(it.name));
          it.kind = 'card';
          if (s) Object.assign(it, { id: s.uuid, icon: s.largeArt || s.smallArt });
        } else if (c === 'player titles') {
          const s = titlesBy.get(norm(it.name));
          it.kind = 'title';
          it.text = s ? s.titleText : it.name.replace(/\s*Title$/, '');
          if (s) it.id = s.uuid;
        } else if (c === 'buddies') {
          const s = buddiesBy.get(norm(it.name));
          it.kind = 'buddy';
          if (s) Object.assign(it, { id: s.uuid, icon: s.displayIcon });
        } else if (c === 'weapon skins') {
          const s = skinsBy.get(norm(it.name));
          it.kind = 'skin';
          if (s) Object.assign(it, { id: s.uuid, icon: (s.levels[0] && s.levels[0].displayIcon) || s.displayIcon });
        } else if (c === 'quotes') {
          it.kind = 'quote';
          it.text = it.name.replace(/\s*Quote$/, '');
        } else if (c === 'stats') {
          it.kind = 'stat';
        } else if (c === 'frames') {
          it.kind = 'frame';
        } else if (c === 'backgrounds') {
          it.kind = 'background';
        } else if (c === 'poses') {
          it.kind = 'pose';
        } else {
          it.kind = 'other';
        }
        delete it.category;
        if (it.id || it.kind === 'stat' || it.kind === 'frame') delete it.wiki;
      }
    }
    if (tiers.length) out[a.uuid.toLowerCase()] = tiers;
    const missing = tiers.flatMap((t) => t.items).filter((i) => ['spray', 'card', 'title', 'buddy', 'skin'].includes(i.kind) && !i.id);
    console.log(`${a.displayName}: ${tiers.length} tiers${missing.length ? `, unmatched: ${missing.map((i) => i.name).join(', ')}` : ''}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(`wrote ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
