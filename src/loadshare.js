'use strict';

// Loadout share links: the owner of a linked account hands out a link that lets anyone
// holding it change the account's skins and gun buddies (and, if the owner allows it,
// player card, title, sprays and flexes) once, within 30 minutes. The visitor needs no
// account. Riot tokens never leave the server: the page only ever sends item IDs, and
// every ID is checked here against what the account really owns before the loadout is
// written.
const crypto = require('node:crypto');
const storage = require('./storage');
const riot = require('./riot');
const shop = require('./shop');
const items = require('./items');

const LINK_TTL_MS = 30 * 60 * 1000;
const SAVE_LOCK_MS = 60 * 1000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Riot's item type IDs (entitlements and the expression wheel).
const TYPE = {
  skinLevel: 'e7c63390-eda7-46e0-bb7a-a6abdacd2433',
  chroma: '3ad1b2b2-acdb-4524-852f-954a76ddae0a',
  buddy: 'dd3bf334-87f3-40bd-b043-682a57a8dc3a',
  spray: 'd5f120f8-ff8c-4aac-92ea-f2b5acbe9475',
  card: '3f296c07-64c3-494c-923b-fe692a4fa1bd',
  title: 'de7caa6b-adf7-4588-bbd1-143831e786c6',
  flex: '03a572de-4234-31ed-d344-ababa488f981',
};
const MELEE_CATEGORY = 'EEquippableCategory::Melee';

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const low = (v) => String(v || '').toLowerCase();
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');
const newNonce = () => crypto.randomBytes(16).toString('hex');
const recKey = (hash) => `lshare:${hash}`;
const usedKey = (hash) => `lshare:used:${hash}`;
const activeKey = (discordId, puuid) => `lshare:active:${discordId}:${puuid}`;
const saveLockKey = (discordId, puuid) => `lshare:save:${discordId}:${puuid}`;

// ---- Item catalog (names, icons, which levels/chromas belong to a skin) ---------------
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
let catalog = null;
let catalogAt = 0;
let catalogPending = null;

async function apiJson(path) {
  const res = await riot.fetchWithTimeout(`https://valorant-api.com/v1/${path}`, {}, 20000);
  if (!res.ok) throw new Error(`catalog ${path} failed (${res.status})`);
  return (await res.json()).data || [];
}

async function buildCatalog() {
  const [weapons, buddies, sprays, cards, titles, flexes] = await Promise.all([
    apiJson('weapons'),
    apiJson('buddies'),
    apiJson('sprays'),
    apiJson('playercards'),
    apiJson('playertitles'),
    apiJson('flex'),
  ]);
  // The main catalog knows which skins are battle pass skins and their rarity tier.
  await items.load().catch(() => {});
  const out = { weapons: new Map(), buddyLevels: new Map(), sprays: new Map(), cards: new Map(), titles: new Map(), flexes: new Map() };
  for (const w of weapons) {
    const skins = [];
    for (const s of w.skins || []) {
      if (!s.levels || !s.levels.length || !s.chromas || !s.chromas.length) continue;
      const name = s.displayName || '';
      let kind = 'normal';
      if (low(s.uuid) === low(w.defaultSkinUuid) || /^standard /i.test(name)) kind = 'standard';
      else if (/random favorite/i.test(name)) kind = 'random';
      const known = items.resolve(s.levels[0].uuid);
      const isSkin = known && known.type === 'skin';
      skins.push({
        id: low(s.uuid),
        name,
        kind,
        tier: (isSkin && known.tier) || null,
        bp: Boolean(isSkin && items.skinKind(known.name, known.tier, known.edition) === 'battlepass'),
        // A standard skin's own displayIcon is a placeholder X; its first chroma holds the real render.
        icon: (kind === 'standard' ? s.chromas[0].fullRender || w.displayIcon : s.displayIcon) || s.chromas[0].fullRender || s.levels[0].displayIcon || null,
        levels: s.levels.map((l, i) => ({ id: low(l.uuid), name: l.displayName || `Level ${i + 1}` })),
        chromas: s.chromas.map((c) => ({ id: low(c.uuid), name: c.displayName || '', icon: c.fullRender || c.displayIcon || null, swatch: c.swatch || null })),
      });
    }
    out.weapons.set(low(w.uuid), { id: low(w.uuid), name: w.displayName, category: w.category, skins, bySkin: new Map(skins.map((s) => [s.id, s])) });
  }
  for (const b of buddies) {
    for (const l of b.levels || []) {
      out.buddyLevels.set(low(l.uuid), { charmId: low(b.uuid), name: b.displayName, icon: l.displayIcon || b.displayIcon || null });
    }
  }
  for (const s of sprays) out.sprays.set(low(s.uuid), { id: low(s.uuid), name: s.displayName, icon: s.animationGif || s.fullTransparentIcon || s.displayIcon || null });
  for (const c of cards) out.cards.set(low(c.uuid), { id: low(c.uuid), name: c.displayName, icon: c.smallArt || c.displayIcon || null, large: c.largeArt || c.wideArt || c.smallArt || null });
  for (const t of titles) out.titles.set(low(t.uuid), { id: low(t.uuid), name: String(t.titleText || t.displayName || '').trim() || 'Title' });
  for (const f of flexes) out.flexes.set(low(f.uuid), { id: low(f.uuid), name: f.displayName, icon: f.displayIcon || null });
  return out;
}

async function getCatalog() {
  if (catalog && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
  if (!catalogPending) {
    catalogPending = buildCatalog()
      .then((c) => {
        catalog = c;
        catalogAt = Date.now();
        return c;
      })
      .finally(() => {
        catalogPending = null;
      });
  }
  try {
    return await catalogPending;
  } catch (err) {
    if (catalog) return catalog; // a stale catalog still lists everything that exists
    throw err;
  }
}

// ---- Links -------------------------------------------------------------------------------

async function readRecord(token) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw httpError('This link is not valid.', 404);
  const hash = hashOf(token);
  const rec = await storage.kvGet(recKey(hash));
  if (!rec) throw httpError('This link is not valid or has expired.', 404);
  if (rec.used || (await storage.kvExists(usedKey(hash)))) throw httpError('This link was already used.', 410);
  if (Date.now() >= rec.expiresAt) throw httpError('This link has expired.', 410);
  return { hash, rec };
}

// One active link per account: making a new one revokes the old one.
async function createLink(discordId, puuid, { cosmetics }) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account) throw httpError('Unknown account.', 404);
  await revokeLink(discordId, puuid);
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = hashOf(token);
  const now = Date.now();
  const rec = { discordId: String(discordId), puuid, cosmetics: Boolean(cosmetics), createdAt: now, expiresAt: now + LINK_TTL_MS, nonce: newNonce(), used: false };
  await storage.kvSet(recKey(hash), rec, LINK_TTL_MS + 60 * 1000);
  await storage.kvSet(activeKey(discordId, puuid), { hash }, LINK_TTL_MS + 60 * 1000);
  return { token, expiresAt: rec.expiresAt, cosmetics: rec.cosmetics };
}

async function revokeLink(discordId, puuid) {
  const ptr = await storage.kvGet(activeKey(discordId, puuid));
  if (ptr && ptr.hash) await storage.kvDel(recKey(ptr.hash));
  await storage.kvDel(activeKey(discordId, puuid));
}

// What the owner sees: whether a link is live, never the link itself.
async function linkStatus(discordId, puuid) {
  const ptr = await storage.kvGet(activeKey(discordId, puuid));
  const rec = ptr && ptr.hash ? await storage.kvGet(recKey(ptr.hash)) : null;
  if (!rec) return { active: false };
  const used = Boolean(rec.used);
  const live = !used && Date.now() < rec.expiresAt;
  return { active: live, used, expired: !used && !live, expiresAt: rec.expiresAt, cosmetics: rec.cosmetics, lastSave: rec.lastSave || null };
}

// ---- Owned items ---------------------------------------------------------------------------

async function loadOwned(ctx) {
  const types = Object.values(TYPE);
  const results = await Promise.all(
    types.map((t) => riot.accountEntitlementsOfType(ctx.shard, ctx.account.puuid, ctx.tokens, t).catch((err) => {
      if (err && err.status === 401) throw err;
      return null;
    }))
  );
  const byType = {};
  types.forEach((t, i) => {
    byType[t] = results[i];
  });
  // A failed lookup must never read as "owns nothing" silently: it blocks saving instead.
  for (const t of [TYPE.skinLevel, TYPE.chroma, TYPE.buddy]) {
    if (!byType[t]) throw httpError('Could not read the account\'s collection from Riot. Try again in a minute.', 502);
  }
  const ids = (t) => new Set(((byType[t] && byType[t].Entitlements) || []).map((e) => low(e.ItemID)));
  const owned = {
    levels: ids(TYPE.skinLevel),
    chromas: ids(TYPE.chroma),
    cards: ids(TYPE.card),
    titles: ids(TYPE.title),
    sprays: ids(TYPE.spray),
    flexes: ids(TYPE.flex),
    cosmeticsKnown: [TYPE.card, TYPE.title, TYPE.spray, TYPE.flex].every((t) => byType[t]),
    buddies: new Map(),
  };
  for (const e of byType[TYPE.buddy].Entitlements || []) {
    if (e.InstanceID) owned.buddies.set(low(e.InstanceID), low(e.ItemID));
  }
  return owned;
}

// The skins of a weapon this account may equip, with only the owned levels and chromas.
function usableSkins(weapon, owned, current) {
  const out = [];
  for (const s of weapon.skins) {
    const standardOrRandom = s.kind === 'standard' || s.kind === 'random';
    const own = standardOrRandom || owned.levels.has(s.levels[0].id);
    const isCurrent = s.id === current.skin;
    if (!own && !isCurrent) continue;
    out.push(limitSkin(s, owned, own, current));
  }
  return out;
}

function limitSkin(s, owned, own, current) {
  const single = s.kind === 'standard' || s.kind === 'random';
  const levels = s.levels.filter((l, i) => i === 0 || (!single && owned.levels.has(l.id)) || (s.id === current.skin && l.id === current.level));
  const chromas = s.chromas.filter((c, i) => i === 0 || (!single && owned.chromas.has(c.id)) || (s.id === current.skin && c.id === current.chroma));
  return { id: s.id, name: s.name, kind: s.kind, tier: s.tier, bp: s.bp, icon: s.icon, owned: own, levels, chromas };
}

const gunState = (g) => ({
  skin: low(g.SkinID),
  level: low(g.SkinLevelID),
  chroma: low(g.ChromaID),
  buddy: g.CharmInstanceID ? low(g.CharmInstanceID) : null,
});

// ---- View --------------------------------------------------------------------------------------

async function viewLink(token) {
  const { hash, rec } = await readRecord(token);
  const ctx = await shop.accountTokens(rec.discordId, rec.puuid);
  if (ctx.status !== 'ok') throw httpError(ctx.status === 'relink' ? 'The account owner needs to sign in to Riot again.' : 'Could not reach Riot. Try again in a minute.', 503);
  const [cat, raw, owned] = await Promise.all([
    getCatalog(),
    riot.playerLoadout(ctx.shard, ctx.account.puuid, ctx.tokens),
    loadOwned(ctx),
  ]);

  const guns = [];
  for (const g of raw.Guns || []) {
    const weapon = cat.weapons.get(low(g.ID));
    if (!weapon) continue;
    const current = gunState(g);
    guns.push({ weapon: weapon.id, name: weapon.name, melee: weapon.category === MELEE_CATEGORY, current, skins: usableSkins(weapon, owned, current) });
  }
  const buddies = [];
  for (const [instanceId, levelId] of owned.buddies) {
    const b = cat.buddyLevels.get(levelId);
    if (b) buddies.push({ instance: instanceId, name: b.name, icon: b.icon });
  }
  buddies.sort((a, b) => a.name.localeCompare(b.name));

  // What the player card, title and wheel show now. Always sent, so the page can draw the
  // loadout; the lists to pick from below only go out when the owner allowed cosmetics.
  const identity = raw.Identity || {};
  const currentCard = cat.cards.get(low(identity.PlayerCardID));
  const currentTitle = cat.titles.get(low(identity.PlayerTitleID));
  const wheel = (raw.ActiveExpressions || []).map((e) => {
    const type = low(e.TypeID) === TYPE.flex ? 'flex' : 'spray';
    const info = (type === 'flex' ? cat.flexes : cat.sprays).get(low(e.AssetID));
    return { type, id: low(e.AssetID), name: info ? info.name : '', icon: info ? info.icon : null };
  });
  const view = {
    guns,
    buddies,
    cosmetics: null,
    identity: {
      card: currentCard ? { id: currentCard.id, name: currentCard.name, large: currentCard.large } : null,
      title: currentTitle ? { id: currentTitle.id, name: currentTitle.name } : null,
      expressions: wheel,
      incognito: Boolean(raw.Incognito),
    },
  };
  if (rec.cosmetics) {
    const pick = (map, set, currentId) => {
      const list = [];
      for (const [id, item] of map) if (set.has(id) || id === low(currentId)) list.push(item);
      return list.sort((a, b) => a.name.localeCompare(b.name));
    };
    const expressions = (raw.ActiveExpressions || []).map((e) => ({ type: low(e.TypeID) === TYPE.flex ? 'flex' : 'spray', id: low(e.AssetID) }));
    view.cosmetics = {
      card: low(identity.PlayerCardID),
      title: low(identity.PlayerTitleID),
      expressions,
      cards: pick(cat.cards, owned.cards, identity.PlayerCardID),
      titles: pick(cat.titles, owned.titles, identity.PlayerTitleID),
      sprays: pick(cat.sprays, owned.sprays, null).concat(expressions.filter((x) => x.type === 'spray' && !owned.sprays.has(x.id) && cat.sprays.get(x.id)).map((x) => cat.sprays.get(x.id))),
      flexes: pick(cat.flexes, owned.flexes, null).concat(expressions.filter((x) => x.type === 'flex' && !owned.flexes.has(x.id) && cat.flexes.get(x.id)).map((x) => cat.flexes.get(x.id))),
    };
  }

  rec.nonce = newNonce();
  await storage.kvSet(recKey(hash), rec, Math.max(rec.expiresAt - Date.now(), 1000) + 60 * 1000);
  return { view, nonce: rec.nonce, expiresAt: rec.expiresAt, cosmetics: rec.cosmetics };
}

// ---- Save ------------------------------------------------------------------------------------------

// Applies the visitor's requested guns to a copy of the loadout. Every value that differs
// from what is equipped now must be something the account owns; values left as they are
// pass untouched so an odd existing state never blocks a save.
function applyGuns(body, requested, cat, owned) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw httpError('Nothing to save.');
  let changes = 0;
  for (const g of body.Guns || []) {
    const weapon = cat.weapons.get(low(g.ID));
    const req = weapon && requested[weapon.id];
    if (!req) continue;
    const cur = gunState(g);

    // Skin, level and chroma.
    const skinId = low(req.skin);
    const skin = weapon.bySkin.get(skinId);
    if (!skin) throw httpError(`Unknown skin for ${weapon.name}.`);
    const single = skin.kind === 'standard' || skin.kind === 'random';
    let levelId = single ? skin.levels[0].id : low(req.level) || skin.levels[0].id;
    let chromaId = single ? skin.chromas[0].id : low(req.chroma) || skin.chromas[0].id;
    if (!skin.levels.some((l) => l.id === levelId)) throw httpError(`Unknown skin level for ${weapon.name}.`);
    if (!skin.chromas.some((c) => c.id === chromaId)) throw httpError(`Unknown skin variant for ${weapon.name}.`);
    const unchanged = skinId === cur.skin && levelId === cur.level && chromaId === cur.chroma;
    if (!unchanged && !single) {
      if (!owned.levels.has(skin.levels[0].id)) throw httpError(`The account does not own ${skin.name}.`, 403);
      if (skin.levels.findIndex((l) => l.id === levelId) > 0 && !owned.levels.has(levelId) && levelId !== cur.level) {
        throw httpError(`The account does not own that level of ${skin.name}.`, 403);
      }
      const chromaIdx = skin.chromas.findIndex((c) => c.id === chromaId);
      if (chromaIdx > 0 && !owned.chromas.has(chromaId) && chromaId !== cur.chroma) {
        throw httpError(`The account does not own that variant of ${skin.name}.`, 403);
      }
    }
    if (!unchanged) {
      g.SkinID = skinId;
      g.SkinLevelID = levelId;
      g.ChromaID = chromaId;
      changes += 1;
    }

    // Buddy.
    const wantBuddy = req.buddy ? low(req.buddy) : null;
    if (wantBuddy !== cur.buddy) {
      if (wantBuddy === null) {
        delete g.CharmInstanceID;
        delete g.CharmID;
        delete g.CharmLevelID;
      } else {
        if (weapon.category === MELEE_CATEGORY) throw httpError('A gun buddy cannot go on the melee weapon.');
        const levelOfBuddy = owned.buddies.get(wantBuddy);
        const info = levelOfBuddy && cat.buddyLevels.get(levelOfBuddy);
        if (!info) throw httpError('The account does not own that gun buddy.', 403);
        g.CharmInstanceID = wantBuddy;
        g.CharmID = info.charmId;
        g.CharmLevelID = levelOfBuddy;
      }
      changes += 1;
    }
  }
  // One copy of a buddy can sit on one gun only.
  const seen = new Set();
  for (const g of body.Guns || []) {
    if (!g.CharmInstanceID) continue;
    const k = low(g.CharmInstanceID);
    if (seen.has(k)) throw httpError('A gun buddy can only be on one weapon at a time.');
    seen.add(k);
  }
  return changes;
}

function applyCosmetics(body, requested, cat, owned) {
  if (!requested || typeof requested !== 'object') return 0;
  if (!owned.cosmeticsKnown) throw httpError('Could not read the account\'s cosmetics from Riot. Try again in a minute.', 502);
  let changes = 0;
  const identity = body.Identity || (body.Identity = {});
  const same = (a, b) => low(a) === low(b);

  if (requested.card !== undefined && !same(requested.card, identity.PlayerCardID)) {
    const id = low(requested.card);
    if (!cat.cards.has(id)) throw httpError('Unknown player card.');
    if (!owned.cards.has(id)) throw httpError('The account does not own that player card.', 403);
    identity.PlayerCardID = id;
    changes += 1;
  }
  if (requested.title !== undefined && !same(requested.title, identity.PlayerTitleID)) {
    const id = low(requested.title);
    if (!cat.titles.has(id)) throw httpError('Unknown title.');
    if (!owned.titles.has(id)) throw httpError('The account does not own that title.', 403);
    identity.PlayerTitleID = id;
    changes += 1;
  }
  if (requested.expressions !== undefined) {
    const list = requested.expressions;
    if (!Array.isArray(list) || list.length !== 4) throw httpError('The expression wheel needs exactly four slots.');
    const current = body.ActiveExpressions || [];
    const next = list.map((x, i) => {
      const type = x && x.type === 'flex' ? 'flex' : 'spray';
      const id = low(x && x.id);
      const cur = current[i];
      const curType = cur && low(cur.TypeID) === TYPE.flex ? 'flex' : 'spray';
      const unchanged = cur && curType === type && low(cur.AssetID) === id;
      if (!unchanged) {
        if (type === 'spray' ? !cat.sprays.has(id) : !cat.flexes.has(id)) throw httpError('Unknown spray or flex.');
        if (!(type === 'spray' ? owned.sprays : owned.flexes).has(id)) throw httpError(`The account does not own that ${type}.`, 403);
        changes += 1;
      }
      return { TypeID: type === 'flex' ? TYPE.flex : TYPE.spray, AssetID: id };
    });
    body.ActiveExpressions = next;
  }
  return changes;
}

async function saveLink(token, payload) {
  const { hash, rec } = await readRecord(token);
  const sent = typeof payload.nonce === 'string' ? payload.nonce : '';
  const a = Buffer.from(sent);
  const b = Buffer.from(rec.nonce || '');
  if (!a.length || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw httpError('This page is out of date. Reload it and try again.', 409);
  }
  if (payload.cosmetics && !rec.cosmetics) throw httpError('The account owner did not allow changing cosmetics.', 403);

  // One save at a time per account, across every link it ever had.
  const lockKey = saveLockKey(rec.discordId, rec.puuid);
  if (!(await storage.kvLock(lockKey, SAVE_LOCK_MS))) throw httpError('Another save is in progress. Try again in a moment.', 409);
  let burned = false;
  try {
    const ctx = await shop.accountTokens(rec.discordId, rec.puuid);
    if (ctx.status !== 'ok') throw httpError(ctx.status === 'relink' ? 'The account owner needs to sign in to Riot again.' : 'Could not reach Riot. Try again in a minute.', 503);
    const [cat, raw, owned] = await Promise.all([
      getCatalog(),
      riot.playerLoadout(ctx.shard, ctx.account.puuid, ctx.tokens),
      loadOwned(ctx),
    ]);

    const body = JSON.parse(JSON.stringify(raw));
    const gunChanges = applyGuns(body, payload.guns, cat, owned);
    const cosmeticChanges = rec.cosmetics ? applyCosmetics(body, payload.cosmetics, cat, owned) : 0;
    const changes = gunChanges + cosmeticChanges;
    if (!changes) return { saved: false, changes: 0, message: 'Nothing was changed.', nonce: rec.nonce };

    // Burn the link before writing. Only one request can win this insert, so a link
    // is never spent twice even if it is hit twice at the same moment.
    if (!(await storage.kvInsert(usedKey(hash), { at: Date.now() }, LINK_TTL_MS * 4))) throw httpError('This link was already used.', 410);
    burned = true;

    await riot.setPlayerLoadout(ctx.shard, ctx.account.puuid, ctx.tokens, body);
    const after = await riot.playerLoadout(ctx.shard, ctx.account.puuid, ctx.tokens);
    const verified = verify(body, after);

    rec.used = true;
    rec.lastSave = { at: Date.now(), changes, verified };
    await storage.kvSet(recKey(hash), rec, LINK_TTL_MS + 60 * 1000);
    // The pointer stays, so the owner's dialog can see the link was used.
    await shop.dropLoadoutCaches(rec.discordId, ctx.account.puuid);
    console.log(`[loadshare] saved ${changes} change(s) on ${String(ctx.account.puuid).slice(0, 8)}, verified=${verified}`);
    return { saved: true, changes, verified };
  } catch (err) {
    // The write did not happen: give the link back so the visitor can retry.
    if (burned) await storage.kvDel(usedKey(hash)).catch(() => {});
    throw err;
  } finally {
    await storage.kvUnlock(lockKey).catch(() => {});
  }
}

// Riot silently drops values it dislikes, so the saved loadout is read back and compared.
function verify(sent, got) {
  const want = new Map((sent.Guns || []).map((g) => [low(g.ID), gunState(g)]));
  for (const g of got.Guns || []) {
    const w = want.get(low(g.ID));
    if (!w) continue;
    const s = gunState(g);
    if (s.skin !== w.skin || s.level !== w.level || s.chroma !== w.chroma || s.buddy !== w.buddy) return false;
  }
  const wi = sent.Identity || {};
  const gi = got.Identity || {};
  if (low(wi.PlayerCardID) !== low(gi.PlayerCardID) || low(wi.PlayerTitleID) !== low(gi.PlayerTitleID)) return false;
  const a = (sent.ActiveExpressions || []).map((e) => `${low(e.TypeID)}:${low(e.AssetID)}`).join(',');
  const b = (got.ActiveExpressions || []).map((e) => `${low(e.TypeID)}:${low(e.AssetID)}`).join(',');
  return a === b;
}

module.exports = { createLink, revokeLink, linkStatus, viewLink, saveLink, LINK_TTL_MS };
