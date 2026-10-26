'use strict';

const { fetchWithTimeout } = require('./riot');

const CURRENCY = {
  vp: '85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741',
  kc: '85ca954a-41f2-ce94-9b45-8ca3dd39a00d',
  agentTokens: 'f08d4ae3-939c-4576-ab26-09ce1f23bb37',
  rp: 'e59aa87c-4cbf-517a-5983-6e81511be9b7',
};

const CURRENCY_LABEL = { vp: 'VP', kc: 'KC', rp: 'RP', agentTokens: 'TOK' };

const API = 'https://valorant-api.com';

// Items the rotating store can never sell are hidden from wishlist search.
// Most of that is derivable from the raw catalog data; battlepass skins and a
// few accessory packs carry no flag, so they are listed here instead. Extend
// these lists when Riot ships a new pass/event.
const LIMITED_EDITION_UUID = '3d190ff8-49c2-2ae5-f8b1-a3b782fb4b79';

// Store vs. collectible gun skin collections. The rotating store only sells
// weapon skins from collections that were released as (non-limited) bundles;
// battle pass skins, agent Gear, and limited/promo drops never return. A skin
// is excluded when its collection matches, using the LONGEST known collection
// prefix so collisions resolve correctly (e.g. store "Celestial" vs pass
// "Celestia", store "Ruination" vs pass "Ruin", store "Prism"/"Prism II" vs
// pass "Prism III"). Unknown collections are treated as eligible: an item
// wrongly hidden is worse than one that shouldn't appear. Data is generated
// from the community wiki's Store and Battle Pass skin templates
// (see skin-collections.json); regenerate when a new act ships.
const SKIN_COLLECTIONS = require('./skin-collections.json');
const EXCLUDED_SKIN_COLLECTIONS = new Set((SKIN_COLLECTIONS.excludedCollections || []).map(normalizeName));
const EXCLUDED_SKIN_NAMES = new Set((SKIN_COLLECTIONS.excludedSkins || []).map(normalizeName));
const SKIN_COLLECTION_PREFIXES = [...new Set([...(SKIN_COLLECTIONS.storeCollections || []), ...(SKIN_COLLECTIONS.excludedCollections || [])])]
  .map(normalizeName)
  .sort((a, b) => b.length - a.length);

function isExcludedSkin(name) {
  const n = normalizeName(name);
  if (EXCLUDED_SKIN_NAMES.has(n)) return true;
  for (const prefix of SKIN_COLLECTION_PREFIXES) {
    if (n.startsWith(prefix)) return EXCLUDED_SKIN_COLLECTIONS.has(prefix);
  }
  return false;
}

// The rotating accessory (Kingdom Credits) shop only ever sells older battle
// pass accessories (buddies, sprays, cards, titles); Riot never offers event
// passes, esports drops, contracts, onboarding or promo giveaways. Rather than
// guess a blocklist from the assetPath, whitelist the exact accessories the
// community wiki lists under each act's battle pass, minus the Epilogue, the
// Coin collection, and the 3 most recent passes (see bp-accessories.json).
// Regenerate that file with the build script when a new act ships. Matching is
// by normalized display name.
// A few skins ship a broken `displayIcon`: a fully opaque 512x512 square with
// no transparency (e.g. Prime Guardian, Luxe Knife, Sovereign Guardian/Marshal,
// and the default Standard/Melee items) instead of the usual transparent cut-out.
// For these, fall back to a transparent source (the first level icon or chroma
// full-render), which is correct. Matching is by normalized display name.
const BAD_DISPLAY_ICON_SKINS = new Set(
  [
    'Prime Guardian',
    'Sovereign Guardian',
    'Sovereign Marshal',
    'Luxe Knife',
    'Melee',
    'Standard Odin',
    'Standard Ares',
    'Standard Vandal',
    'Standard Bulldog',
    'Standard Phantom',
    'Standard Judge',
    'Standard Bucky',
    'Standard Frenzy',
    'Standard Classic',
    'Standard Ghost',
    'Standard Sheriff',
    'Standard Shorty',
    'Standard Operator',
    'Standard Guardian',
    'Standard Marshal',
    'Standard Spectre',
    'Standard Stinger',
  ].map(normalizeName)
);

// ==== Skin origin buckets (/collection) =======================================
// The source-of-truth for "where did this skin come from" is Riot's contracts
// list: agent contracts (assetPath .../Contracts/Characters/...) grant exactly
// one weapon skin per agent, and the act passes (.../Contracts/Story/...) hold
// every battle pass skin. Matching is by normalized skin name; the raw reward
// uuids are skin LEVEL ids which the catalog already resolves to skin names.
// This keeps up with new acts without touching skin-collections.json. When the
// contracts data is temporarily unavailable, fall back to the Select-tier +
// store-ineligible heuristic.
const CONTRACTS_TTL = 24 * 60 * 60 * 1000;
let contractsAt = 0;
let contractsLoading = null;
const AGENT_SKIN_NAMES = new Set();
const BP_SKIN_NAMES = new Set();

const BP_ACCESSORIES = require('./bp-accessories.json');

async function loadContracts() {
  if (Date.now() - contractsAt < CONTRACTS_TTL) return;
  if (contractsLoading) return contractsLoading;
  if (!catalog) return; // reward uuids resolve through the catalog
  contractsLoading = (async () => {
    try {
      const json = await fetchJson(`${API}/v1/contracts`);
      // Stage into locals so a failed or partial refresh never wipes a good set.
      const agent = new Set(AGENT_SKIN_NAMES);
      const bp = new Set(BP_SKIN_NAMES);
      for (const contract of json.data || []) {
        const isAgent = String(contract.assetPath || '').includes('Contracts/Characters');
        const isPass = String(contract.assetPath || '').includes('Contracts/Story');
        if (!isAgent && !isPass) continue;
        const target = isAgent ? agent : bp;
        for (const ch of (contract.content && contract.content.chapters) || []) {
          const rewards = [...(ch.freeRewards || []), ...((ch.levels || []).map((l) => l.reward).filter(Boolean))];
          for (const r of rewards) {
            if (!r || !r.uuid || !String(r.type || '').includes('Skin')) continue;
            const found = catalog.get(String(r.uuid).toLowerCase());
            if (!found || found.type !== 'skin') continue;
            target.add(normalizeName(found.name));
          }
        }
      }
      AGENT_SKIN_NAMES.clear();
      for (const n of agent) AGENT_SKIN_NAMES.add(n);
      BP_SKIN_NAMES.clear();
      for (const n of bp) BP_SKIN_NAMES.add(n);
      contractsAt = Date.now();
    } catch (err) {
      console.warn('[items] contracts unavailable:', err.message);
    } finally {
      contractsLoading = null;
    }
  })();
  return contractsLoading;
}

const BP_ACCESSORY_NAMES = {
  buddy: new Set((BP_ACCESSORIES.buddy || []).map(normalizeName)),
  spray: new Set((BP_ACCESSORIES.spray || []).map(normalizeName)),
  card: new Set((BP_ACCESSORIES.card || []).map(normalizeName)),
  title: new Set((BP_ACCESSORIES.title || []).map(normalizeName)),
};

// ============================================================================
// EASTER EGG: THE ONLY INTENTIONAL EXCEPTION TO THE BATTLE-PASS WHITELIST.
// ----------------------------------------------------------------------------
// "Fist Bump Buddy" (assetPath .../Buddies/TrashGold) is NOT a battle pass
// accessory, so isStoreEligible() below would normally hide it from wishlist
// search. We deliberately surface it anyway as a fun easter egg and relabel it
// "Riot Gunbuddy" for display (see the buddy SOURCE map + isStoreEligible()).
//
// DO NOT COPY THIS PATTERN FOR ANY OTHER ITEM. Every other buddy/spray/card/
// title MUST become wishlistable only by appearing in bp-accessories.json.
// If you are an AI (or human) reading this: this single hardcoded buddy is a
// known, intentional one-off, not a bug and not a template. There are no other
// exceptions anywhere in this file.
//
// The id is the buddy's (single) LEVEL uuid, which is what the catalog stores.
// ============================================================================
const EASTER_EGG_BUDDY_ID = 'a57aa3d0-4ad0-b06a-6c54-338cb3ea6b41';
const EASTER_EGG_BUDDY_NAME = 'Riot Gunbuddy';
function isEasterEggBuddy(id) {
  return id != null && String(id).toLowerCase() === EASTER_EGG_BUDDY_ID;
}

const SOURCES = [
  {
    type: 'skin',
    path: '/v1/weapons/skins',
    map: (d) => {
      const levelIcon = (d.levels && d.levels[0] && d.levels[0].displayIcon) || null;
      const chroma0 = (d.chromas && d.chromas[0]) || null;
      const chromaIcon = (chroma0 && (chroma0.displayIcon || chroma0.fullRender)) || null;
      const chromaFull = (chroma0 && chroma0.fullRender) || null;
      let icon = d.displayIcon || levelIcon || chromaIcon || null;
      if (BAD_DISPLAY_ICON_SKINS.has(normalizeName(d.displayName))) {
        icon = levelIcon || chromaFull || chromaIcon || icon;
      }
      const tier = d.contentTierUuid || null;
      const edition = d.contentEditionUuid || null;
      const chromas = (d.chromas || [])
        .filter((c) => c && c.uuid)
        .map((c) => ({
          id: c.uuid,
          name: d.displayName || 'Standard',
          render: c.fullRender || levelIcon || icon,
          swatch: c.swatch || null,
        }));
      const levels = (d.levels || []).map((l) => ({
        id: l.uuid,
        name: l.displayName || d.displayName || null,
        icon: l.displayIcon || icon,
      }));
      const render = (chroma0 && chroma0.fullRender) || icon;
      const extra = { skinId: d.uuid, render, chromas, levels };
      const out = [{ id: d.uuid, name: d.displayName, icon, tier, edition, ...extra }];
      for (const level of d.levels || []) {
        // Ownership grants every level of a skin, and a skin's later levels often
        // ship their own opaque "upgrade" thumbnail (e.g. Prime Vandal L2-L4)
        // instead of the transparent cut-out. Since callers dedupe a skin by
        // name and may hit any level uuid first, every level entry shares the
        // skin's good base `icon`. The per-level icons stay available under
        // `levels` for the item preview modal.
        out.push({ id: level.uuid, name: d.displayName, icon, tier, edition, ...extra });
      }
      return out;
    },
  },
  {
    type: 'buddy',
    path: '/v1/buddies',
    map: (d) => {
      const src = assetFolder(d.assetPath, 'Buddies');
      const levels = d.levels || [];
      // Easter egg: "Fist Bump Buddy" is displayed as "Riot Gunbuddy" (see the
      // EASTER_EGG_* constants above). This is the only name override. Its
      // per-level icon ships as a broken 32x32 placeholder, so use the buddy's
      // top-level art for it instead.
      const nameFor = (id) => (isEasterEggBuddy(id) ? EASTER_EGG_BUDDY_NAME : d.displayName);
      const iconFor = (id, lvlIcon) => (isEasterEggBuddy(id) ? d.displayIcon || lvlIcon : lvlIcon) || null;
      const out = levels.map((l) => ({ id: l.uuid, name: nameFor(l.uuid), icon: iconFor(l.uuid, l.displayIcon), src }));
      if (!levels.length) out.push({ id: d.uuid, name: nameFor(d.uuid), icon: iconFor(d.uuid, null), src });
      return out;
    },
  },
  {
    type: 'spray',
    path: '/v1/sprays',
    map: (d) => {
      const src = assetFolder(d.assetPath, 'Sprays');
      // Sprays that ship an animated version use the GIF on the website. The
      // static icon is kept separately because the Discord shop grid is a
      // rasterised PNG and cannot render an animated GIF frame.
      const staticIcon = d.fullTransparentIcon || d.displayIcon || null;
      const gif = d.animationGif || null;
      const icon = gif || staticIcon;
      const out = [{ id: d.uuid, name: d.displayName, icon, staticIcon, src }];
      for (const level of d.levels || []) {
        const levelStatic = level.fullTransparentIcon || level.displayIcon || staticIcon;
        out.push({ id: level.uuid, name: d.displayName, icon: gif || levelStatic, staticIcon: levelStatic, src });
      }
      return out;
    },
  },
  {
    type: 'card',
    path: '/v1/playercards',
    map: (d) => [
      {
        id: d.uuid,
        name: d.displayName,
        icon: d.wideArt || d.displayIcon || d.smallArt || null,
        art: { small: d.smallArt || null, wide: d.wideArt || null, large: d.largeArt || null },
        src: assetFolder(d.assetPath, 'PlayerCards'),
      },
    ],
  },
  {
    // Flexes (Equippables/Totems) are their own entitlement type. "None" is
    // the empty default slot, not an item, so it is left out of the catalog.
    type: 'flex',
    path: '/v1/flex',
    map: (d) => (/^none$/i.test(String(d.displayName || '').trim())
      ? []
      : [{ id: d.uuid, name: d.displayName, icon: d.displayIcon || null, src: assetFolder(d.assetPath, 'Totems') }]),
  },
  {
    type: 'title',
    path: '/v1/playertitles',
    map: (d) => [{ id: d.uuid, name: d.displayName, icon: null, src: assetFolder(d.assetPath, 'Titles') }],
  },
  {
    type: 'bundle',
    path: '/v1/bundles',
    map: (d) => [{ id: d.uuid, name: d.displayName, icon: d.displayIcon || null }],
  },
];

let catalog = null;
let catalogAt = 0;
let loading = null;
const tierNames = new Map();
const tierIcons = new Map();
const TTL = 12 * 60 * 60 * 1000;

async function fetchJson(url, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 12000);
      const json = await res.json();
      if (!res.ok || json.status !== 200) throw new Error(`HTTP ${res.status}`);
      return json;
    } catch (err) {
      lastError = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastError;
}

let tierAttemptAt = 0;
let tierLoading = null;
let tierFetchedAt = 0;

async function loadTiers() {
  if (tierNames.size && Date.now() - tierFetchedAt < TTL) return;
  if (tierLoading) return tierLoading;
  if (Date.now() - tierAttemptAt < 60000) return;
  tierAttemptAt = Date.now();
  tierLoading = (async () => {
    try {
      const tiers = await fetchJson(`${API}/v1/contenttiers`);
      for (const t of tiers.data || []) {
        if (!t || !t.uuid) continue;
        const name = (t.displayName || '').replace(/\s+Edition$/i, '') || null;
        tierNames.set(String(t.uuid).toLowerCase(), name);
        if (name && t.displayIcon) tierIcons.set(name, t.displayIcon);
      }
      tierFetchedAt = Date.now();
    } catch (err) {
      console.warn('[items] content tiers unavailable:', err.message);
    } finally {
      tierLoading = null;
    }
  })();
  return tierLoading;
}

async function load(force = false) {
  if (!force && catalog && Date.now() - catalogAt < TTL) {
    await loadContracts().catch(() => {});
    await loadTiers();
    return catalog;
  }
  if (loading) return loading;

  loading = (async () => {
    const [results, weapons] = await Promise.all([
      Promise.allSettled(
        SOURCES.map(async (src) => {
          const json = await fetchJson(`${API}${src.path}`);
          return json.data.flatMap(src.map);
        })
      ),
      // Weapon skins don't carry their weapon/type, so pull it from the weapons
      // endpoint and key it by skin uuid. Without it the owned-skins filters in
      // the account details modal have no category to group by.
      fetchJson(`${API}/v1/weapons`).catch(() => null),
    ]);

    const weaponBySkin = new Map();
    for (const w of (weapons && weapons.data) || []) {
      if (!w || !w.category) continue;
      const category = String(w.category).replace(/^EEquippableCategory::/, '') || null;
      for (const sk of w.skins || []) {
        if (sk && sk.uuid) weaponBySkin.set(String(sk.uuid).toLowerCase(), { weapon: w.displayName || null, category });
      }
    }

    const map = new Map();
    let ok = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          ok += 1;
          for (const entry of r.value) {
            if (entry && entry.id) {
              const key = String(entry.id).toLowerCase();
              if (!map.has(key)) {
                const enriched = { ...entry, type: SOURCES[i].type };
                if (enriched.type === 'skin' && enriched.skinId) {
                  const wt = weaponBySkin.get(String(enriched.skinId).toLowerCase());
                  if (wt) {
                    enriched.category = wt.category;
                    enriched.weapon = wt.weapon;
                  }
                }
                map.set(key, enriched);
              }
            }
          }
        } else {
          console.warn(`[items] failed to load ${SOURCES[i].path}:`, r.reason && r.reason.message);
        }
      });

    if (ok === 0 && !catalog) throw new Error('item catalog unavailable');
    if (ok === 0) {
      console.warn('[items] catalog refresh failed entirely, keeping stale copy');
    } else if (ok < SOURCES.length && catalog) {
      console.warn(`[items] partial catalog refresh (${ok}/${SOURCES.length} sources), merging into stale copy`);
      const merged = new Map(catalog);
      for (const [k, v] of map) merged.set(k, v);
      catalog = merged;
    } else if (map.size) {
      catalog = map;
    }
    catalogAt = Date.now();

    await loadContracts().catch(() => {});
    await loadTiers();

    return catalog;
  })();

  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function resolve(id) {
  const key = id ? String(id).toLowerCase() : null;
  const found = key && catalog ? catalog.get(key) : null;
  if (!found) {
    return { id: id || null, type: 'unknown', name: 'Unknown Item', icon: null, tier: null };
  }
  return {
    id: found.id,
    type: found.type,
    name: found.name,
    icon: found.icon,
    staticIcon: found.staticIcon || null,
    art: found.art || null,
    tier: found.tier ? tierNames.get(String(found.tier).toLowerCase()) || null : null,
    edition: found.edition || null,
    category: found.category || null,
    weapon: found.weapon || null,
  };
}

// Skin bucket for /collection (counts only; no full item lists):
//   limited    - Exclusive Edition (VCT knives/Classics, Champions, Arcane)
//   agent      - one weapon skin granted by each agent contract
//   battlepass - act-pass skins from the act contracts document
//   standard   - everything else (store skins)
// Falls back to the Select-tier + store-ineligible heuristic when the contracts
// snapshot has not loaded yet.
function skinKind(name, tier, edition) {
  if (edition === LIMITED_EDITION_UUID) return 'limited';
  const n = normalizeName(name);
  if (AGENT_SKIN_NAMES.size && AGENT_SKIN_NAMES.has(n)) return 'agent';
  if (BP_SKIN_NAMES.size && BP_SKIN_NAMES.has(n)) return 'battlepass';
  if (tier === 'Select' && isExcludedSkin(name)) return 'battlepass';
  return 'standard';
}

// The store response (and its cached copy) bakes in each item's artwork at build
// time, so a cached store can be up to 45 minutes behind the live catalog. Re-
// resolve the artwork on the way out so the website always shows current icons
// (e.g. animated sprays) without waiting for the cache to roll over.
function refreshIcons(store) {
  if (!store || typeof store !== 'object') return store;
  for (const box of [store.daily, store.kingdomShop, store.nightMarket]) {
    if (!box || !Array.isArray(box.items)) continue;
    for (const it of box.items) {
      if (!it || !it.id) continue;
      const r = resolve(it.id);
      if (r.icon) it.icon = r.icon;
      if (r.staticIcon) it.staticIcon = r.staticIcon;
    }
  }
  return store;
}

async function tierIcon(name) {
  if (!name) return null;
  await loadTiers();
  return tierIcons.get(name) || null;
}

// Competitive rank metadata: tier number -> { name, icon, color }, from the
// latest act's tier set. Turns the raw MMR tier into a rank name and badge.
let rankTiers = null;
let rankTiersAt = 0;
async function competitiveTiers() {
  if (rankTiers && Date.now() - rankTiersAt < TTL) return rankTiers;
  try {
    const json = await fetchJson(`${API}/v1/competitivetiers`);
    const list = json.data || [];
    const latest = list[list.length - 1] || {};
    const map = new Map();
    for (const t of latest.tiers || []) {
      if (!t) continue;
      map.set(Number(t.tier), {
        name: t.tierName || null,
        icon: t.largeIcon || t.smallIcon || null,
        color: t.color || null,
      });
    }
    rankTiers = map;
    rankTiersAt = Date.now();
    return map;
  } catch {
    return rankTiers || new Map();
  }
}

function rankTier(n) {
  if (!rankTiers || n == null) return null;
  return rankTiers.get(Number(n)) || null;
}

// Rich preview payload for the dashboard's item look-over popup. Skins carry
// their chromas + levels and a large render; player cards carry the three art
// sizes. Everything else just returns the plain resolved item.
async function details(id) {
  const key = id ? String(id).toLowerCase() : null;
  const found = key && catalog ? catalog.get(key) : null;
  const base = resolve(id);
  if (!found) return { ...base, render: base.icon, chromas: null, levels: null };
  if (found.type === 'skin') {
    await loadTiers();
    const tierName = found.tier ? tierNames.get(String(found.tier).toLowerCase()) || null : null;
    return {
      ...base,
      render: found.render || base.icon,
      tierIcon: tierName ? tierIcons.get(tierName) || null : null,
      chromas: (found.chromas || []).map((c) => ({ id: c.id, name: c.name, render: c.render, swatch: c.swatch })),
      levels: (found.levels || []).map((l) => ({ id: l.id, name: l.name, icon: l.icon })),
    };
  }
  if (found.type === 'card') {
    return { ...base, art: found.art || base.art };
  }
  return { ...base, render: base.icon };
}

function byType(type) {
  if (!catalog) return [];
  return [...catalog.values()].filter((v) => v.type === type);
}

function assetFolder(path, root) {
  if (!path) return null;
  const idx = path.indexOf(root);
  if (idx === -1) return null;
  const rest = path.slice(idx + root.length).replace(/^\/+/, '');
  return (rest.split('/')[0] || null).toLowerCase();
}

// True when the rotating store can actually sell this item. Wishlist search
// only returns store-eligible results.
function isStoreEligible(entry) {
  if (entry.type === 'skin') {
    if (!entry.tier) return false; // Standard defaults and "Random Favorite"
    if (entry.edition === LIMITED_EDITION_UUID) return false; // Champions, Arcane, VCT, ...
    return !isExcludedSkin(entry.name);
  }
  if (entry.type === 'buddy' || entry.type === 'spray' || entry.type === 'card' || entry.type === 'title') {
    // Easter egg: the single deliberate exception to the battle-pass whitelist
    // (see EASTER_EGG_BUDDY_ID above). Every other accessory must be in the BP
    // list to be wishlistable.
    if (entry.type === 'buddy' && isEasterEggBuddy(entry.id)) return true;
    const set = BP_ACCESSORY_NAMES[entry.type];
    return !!set && set.has(normalizeName(entry.name));
  }
  return true;
}

function isStoreEligibleId(id) {
  const key = id ? String(id).toLowerCase() : null;
  const entry = key && catalog ? catalog.get(key) : null;
  return entry ? isStoreEligible(entry) : true;
}

// Diagnostic snapshot of the skin-origin sets (agent contract / battle pass).
function skinBuckets() {
  return { agent: [...AGENT_SKIN_NAMES], battlepass: [...BP_SKIN_NAMES] };
}

// Wishlist kind for an item type: skins live in the daily shop, the rest in the
// accessory (Kingdom Credits) shop. Unknown/unsupported types return null.
function kindOf(type) {
  if (type === 'skin') return 'daily';
  if (type === 'buddy' || type === 'spray' || type === 'card' || type === 'title') return 'accessory';
  return null;
}

function normalizeName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Catalog search for the dashboard add-to-wishlist UI. Only store-eligible
// items are returned. Dedupes by normalized name because skins are listed once
// per level uuid in the catalog.
async function search(query, kind, limit = 30) {
  await load().catch(() => {});
  if (!catalog) return [];
  const q = normalizeName(query);
  const wantKind = kind === 'daily' || kind === 'accessory' ? kind : null;
  const max = Math.max(1, Math.min(Number(limit) || 30, 100));
  const seen = new Set();
  const buckets = new Map();
  for (const entry of catalog.values()) {
    if (!isStoreEligible(entry)) continue;
    const k = kindOf(entry.type);
    if (!k || (wantKind && k !== wantKind)) continue;
    if (q && !normalizeName(entry.name).includes(q)) continue;
    const key = `${k}:${normalizeName(entry.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!buckets.has(entry.type)) buckets.set(entry.type, []);
    buckets.get(entry.type).push({ ...resolve(entry.id), kind: k });
  }
  // Interleave item types so an empty query shows a mix instead of a wall of
  // the first catalog type (buddies come before sprays/cards/titles).
  const lists = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < max; i += 1) {
    let progressed = false;
    for (const list of lists) {
      if (i < list.length) {
        out.push(list[i]);
        progressed = true;
        if (out.length >= max) break;
      }
    }
    if (!progressed) break;
  }
  return out;
}

// Compact, deduped list of every store-eligible item, used by the dashboard to
// search the wishlist catalog fully client-side (instant filtering, no cap).
// Short keys keep the payload small; `kind` is derived from `type` on the client.
function storeIndex() {
  if (!catalog) return [];
  const seen = new Set();
  const out = [];
  for (const entry of catalog.values()) {
    if (!isStoreEligible(entry)) continue;
    const k = kindOf(entry.type);
    if (!k) continue;
    const key = `${k}:${normalizeName(entry.name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = resolve(entry.id);
    const o = { i: r.id, n: r.name, t: r.type, c: r.icon || null };
    if (r.type === 'card' && r.art) {
      o.a = { s: r.art.small || null, w: r.art.wide || null, l: r.art.large || null };
    }
    out.push(o);
  }
  out.sort((a, b) => a.n.localeCompare(b.n));
  return out;
}

let currencyCache = null;
let currencyAt = 0;

async function currencies() {
  if (currencyCache && Date.now() - currencyAt < TTL) return currencyCache;
  try {
    const json = await fetchJson(`${API}/v1/currencies`);
    const map = new Map();
    for (const c of json.data) {
      map.set(c.uuid, { name: c.displayName, icon: c.displayIcon, label: c.displayName.slice(0, 2).toUpperCase() });
    }
    currencyCache = map;
    currencyAt = Date.now();
    return map;
  } catch {
    return currencyCache || new Map();
  }
}

module.exports = { CURRENCY, CURRENCY_LABEL, load, resolve, refreshIcons, details, byType, search, storeIndex, kindOf, normalizeName, currencies, tierIcon, competitiveTiers, rankTier, isStoreEligible, isStoreEligibleId, skinKind, skinBuckets };
