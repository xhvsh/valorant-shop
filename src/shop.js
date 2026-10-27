'use strict';

const riot = require('./riot');
const storage = require('./storage');
const items = require('./items');
const { buildStoreResponse } = require('./parse');

const STORE_TTL = 45 * 60 * 1000;
// Accept tokens up to this far from expiry so we never use one that dies mid-request.
const TOKEN_SKEW_MS = 60 * 1000;
const ENTITLEMENT_TTL_MS = 50 * 60 * 1000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function nextMidnightUtc() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}

// Only a rejected refresh grant means the user must re-link. Rate limits,
// outages, and timeouts are transient and must never flip an account to RELINK.
function isRevokedError(e) {
  if (!e || (e.status !== 400 && e.status !== 401 && e.status !== 403)) return false;
  const msg = String(e.message || '').toLowerCase();
  return msg.includes('invalid_grant') || msg.includes('invalid grant');
}

// Renews an account session with the DPoP-bound ritoplus refresh token.
// Throws REVOKED when the grant itself is dead, TRANSIENT after retries when
// Riot is just having a moment.
async function renewTokens(auth, opts = {}) {
  if (!auth || !auth.refresh_token) {
    const err = new Error('Riot session expired.');
    err.code = 'REVOKED';
    throw err;
  }
  const attempts = opts.retries == null ? 2 : opts.retries;
  let lastErr = null;
  for (let i = 0; i <= attempts; i += 1) {
    try {
      const next = await riot.refreshDpop(storage, auth.refresh_token);
      if (!next || !next.access_token) throw new Error('Riot returned no access token.');
      return {
        access_token: next.access_token,
        id_token: next.id_token || auth.id_token || null,
        expires_at: next.expires_at,
        cookies: null,
        refresh_token: next.refresh_token || auth.refresh_token,
      };
    } catch (e) {
      lastErr = e;
      if (isRevokedError(e)) {
        const err = new Error('Riot session expired.');
        err.code = 'REVOKED';
        throw err;
      }
      if (i < attempts) await sleep(500 * (i + 1));
    }
  }
  const err = new Error(`Riot refresh failed (${(lastErr && lastErr.message) || 'unknown error'}).`);
  err.code = 'TRANSIENT';
  throw err;
}

// Refresh tokens rotate, so spending one twice poisons the account. Two layers
// stop that: calls in one process share a single refresh (refreshLocks), and
// across serverless instances a short lock row in the database lets one instance
// refresh while the others wait for its result and reuse the tokens it saved.
const REFRESH_LOCK_TTL_MS = 30 * 1000;
const REFRESH_WAIT_MS = 12 * 1000;
const REFRESH_POLL_MS = 400;
const refreshLocks = new Map();

async function storedAuth(discordId, puuid) {
  const acct = await storage.getAccount(discordId, puuid || undefined);
  if (!acct || !acct.auth_encrypted) return null;
  try {
    return storage.decrypt(acct.auth_encrypted);
  } catch {
    return null;
  }
}

function freshEnough(auth) {
  return Boolean(auth && auth.access_token && auth.expires_at && auth.expires_at > Date.now() + TOKEN_SKEW_MS);
}

async function refreshAcrossInstances(discordId, puuid, auth) {
  const lockKey = `refresh_lock:${discordId}:${puuid || ''}`;
  const deadline = Date.now() + REFRESH_WAIT_MS;
  for (;;) {
    // Another instance may already have refreshed and saved: reuse its tokens.
    const stored = await storedAuth(discordId, puuid).catch(() => null);
    if (stored && stored.refresh_token && stored.refresh_token !== auth.refresh_token && freshEnough(stored)) {
      return {
        access_token: stored.access_token,
        id_token: stored.id_token || auth.id_token || null,
        expires_at: stored.expires_at,
        cookies: null,
        refresh_token: stored.refresh_token,
      };
    }
    // If the lock store itself fails, refresh unguarded rather than fail the shop.
    const held = await storage.kvLock(lockKey, REFRESH_LOCK_TTL_MS).catch(() => true);
    if (held) {
      try {
        // Always spend the newest refresh token on record.
        const base = stored && stored.refresh_token ? stored : auth;
        const next = await renewTokens(base, { discordId });
        // Persist before releasing, so waiters find the new tokens.
        try {
          await storage.saveAccount(discordId, puuid, {
            auth_encrypted: storage.encrypt({
              ...base,
              access_token: next.access_token,
              id_token: next.id_token,
              expires_at: next.expires_at,
              refresh_token: next.refresh_token,
            }),
          });
        } catch (e) {
          console.warn(`[shop] token persist failed for ${discordId}: ${(e && e.message) || e}`);
        }
        return next;
      } finally {
        await storage.kvUnlock(lockKey).catch(() => {});
      }
    }
    if (Date.now() > deadline) {
      const err = new Error('Riot refresh is busy.');
      err.code = 'TRANSIENT';
      throw err;
    }
    await sleep(REFRESH_POLL_MS);
  }
}

function lockedRefresh(discordId, puuid, auth) {
  const key = `${String(discordId)}:${String(puuid || '')}`;
  const existing = refreshLocks.get(key);
  if (existing) return existing;
  const p = (async () => {
    try {
      return await refreshAcrossInstances(discordId, puuid, auth);
    } finally {
      if (refreshLocks.get(key) === p) refreshLocks.delete(key);
    }
  })();
  refreshLocks.set(key, p);
  return p;
}

async function ensureAccessToken(discordId, puuid, auth) {
  if (auth.access_token && auth.expires_at && auth.expires_at > Date.now() + TOKEN_SKEW_MS) {
    return { access_token: auth.access_token };
  }
  let fresh;
  try {
    fresh = await lockedRefresh(discordId, puuid, auth);
  } catch (e) {
    if (e && e.code === 'REVOKED') {
      const err = new Error('Riot session expired.');
      err.code = 'RELINK';
      throw err;
    }
    throw e;
  }
  auth.access_token = fresh.access_token;
  auth.id_token = fresh.id_token || auth.id_token;
  auth.expires_at = fresh.expires_at;
  auth.refresh_token = fresh.refresh_token;
  if (fresh.cookies) auth.cookies = fresh.cookies;
  try {
    await storage.saveAccount(discordId, puuid, { auth_encrypted: storage.encrypt(auth) });
  } catch (e) {
    console.warn(`[shop] token persist failed for ${discordId}: ${(e && e.message) || e}`);
  }
  return { access_token: fresh.access_token };
}

// Entitlements live as long as the access token, so cache them instead of
// minting a fresh one on every shop call.
const entitlementCache = new Map();
async function entitlementFor(accessToken) {
  const hit = entitlementCache.get(accessToken);
  if (hit && Date.now() - hit.at < ENTITLEMENT_TTL_MS) return hit.entitlement;
  let entitlement;
  try {
    entitlement = await riot.entitlements(accessToken);
  } catch (e) {
    if (e && e.status === 401) {
      const err = new Error('Riot session expired.');
      err.code = 'RELINK';
      throw err;
    }
    throw e;
  }
  if (entitlementCache.size > 500) entitlementCache.clear();
  entitlementCache.set(accessToken, { entitlement, at: Date.now() });
  return entitlement;
}

async function resetAtFor(discordId, puuid) {
  const box = await storage.kvGet(`shop_reset:${discordId}:${puuid || ''}`).catch(() => null);
  if (box && box.at) return box.at;
  // Legacy single-account key, read once on cutover.
  const legacy = await storage.kvGet(`shop_reset:${discordId}`).catch(() => null);
  return (legacy && legacy.at) || 0;
}

// The saved store already bakes in the daily panel's rotation instant (the same
// instant the shop_reset key records), so the freshness check needs no second
// read. Only fall back to that key when the daily panel has no timestamp.
function resetAtFromStore(store) {
  const daily = store && store.daily;
  return (daily && daily.expiresAt) || 0;
}

// Returns the cached store, or null when it is stale: older than the TTL or past
// the shop's own rotation instant (stored at fetch time from the storefront's
// remaining-duration counter).
function cachedStore(account, resetAt) {
  if (
    account &&
    account.store_cache &&
    account.store_updated_at &&
    Date.now() - account.store_updated_at < STORE_TTL &&
    (!resetAt || Date.now() < resetAt)
  ) {
    return account.store_cache;
  }
  return null;
}

// A cached store bakes in each item's artwork at fetch time, so it can lag
// behind the live catalog (e.g. before sprays gained animated GIF icons).
// Re-resolve the artwork on the way out so the website and Discord always see
// current icons, even while the 45-minute cache is still valid.
async function freshStore(store) {
  try {
    await items.load();
  } catch (e) {
    console.warn(`[shop] catalog refresh failed, keeping cached icons: ${(e && e.message) || e}`);
  }
  return items.refreshIcons(store);
}

// ---- Owned markers -------------------------------------------------------------
// Items in the daily shop, accessory shop and Night Market that the account
// already owns get `owned: true`, so the website and Discord can show a
// "purchased" mark. Ownership comes from the PD entitlements list and is applied
// to a copy on the way out: the saved store_cache never carries it, because it
// goes stale the moment the player buys something.
const OWNED_TTL = 3 * 60 * 1000;
const OWNED_FAIL_TTL = 60 * 1000;
const OWNABLE = new Set(['skin', 'buddy', 'spray', 'card', 'title', 'flex']);

function ownedKey(item) {
  const name = items.normalizeName(item && item.name);
  return item && OWNABLE.has(item.type) && name ? `${item.type}:${name}` : null;
}

function storeBoxes(store) {
  return [store && store.daily, store && store.kingdomShop, store && store.nightMarket];
}

// getTokens() runs only on a cache miss, so a cached shop still costs no Riot
// call while the ownership answer is fresh. The cache keeps just this store's
// item keys (checked) and which of them are owned, and is reused only while the
// store holds nothing outside `checked`.
async function withOwned(store, discordId, account, getTokens) {
  if (!store) return store;
  const keys = new Set();
  for (const box of storeBoxes(store)) {
    for (const it of (box && box.items) || []) {
      const k = ownedKey(it);
      if (k) keys.add(k);
    }
  }
  if (!keys.size) return store;

  const cacheKey = `owned:v1:${discordId}:${account.puuid}`;
  const box = await storage.kvGet(cacheKey).catch(() => null);
  let owned = null;
  if (box && box.at && Date.now() - box.at < (box.failed ? OWNED_FAIL_TTL : OWNED_TTL)) {
    if (box.failed) return store;
    const checked = new Set(box.checked || []);
    if ([...keys].every((k) => checked.has(k))) owned = new Set(box.owned || []);
  }
  if (!owned) {
    try {
      const tokens = await getTokens();
      const res = await riot.accountEntitlements(account.shard || 'na', account.puuid, tokens);
      const have = new Set();
      for (const e of entitlementList(res)) {
        if (!e || !e.ItemID) continue;
        const k = ownedKey(items.resolve(e.ItemID));
        if (k) have.add(k);
      }
      owned = new Set([...keys].filter((k) => have.has(k)));
      await storage
        .kvSet(cacheKey, { at: Date.now(), checked: [...keys], owned: [...owned] }, OWNED_TTL)
        .catch(() => {});
    } catch (e) {
      console.warn(`[shop] owned lookup failed for ${discordId}: ${(e && e.message) || e}`);
      await storage.kvSet(cacheKey, { at: Date.now(), failed: true }, OWNED_FAIL_TTL).catch(() => {});
      return store;
    }
  }
  if (!owned.size) return store;

  const mark = (b) =>
    b && Array.isArray(b.items)
      ? { ...b, items: b.items.map((it) => (owned.has(ownedKey(it)) ? { ...it, owned: true } : it)) }
      : b;
  return { ...store, daily: mark(store.daily), kingdomShop: mark(store.kingdomShop), nightMarket: mark(store.nightMarket) };
}

// Tokens for an account whose store came from cache (no tokens in hand yet).
async function tokensFor(discordId, account) {
  const token = await ensureAccessToken(discordId, account.puuid, storage.decrypt(account.auth_encrypted));
  return { ...token, entitlement: await entitlementFor(token.access_token) };
}

// Returns { status: 'unlinked' | 'ok' | 'relink' | 'error', store?, account?, error? }
// Omit puuid to use the user's default account. Pass `owned: false` when the
// caller only needs the store itself (e.g. bundles) to skip the ownership lookup.
async function getShop(discordId, puuid, opts = {}) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account) return { status: 'unlinked' };

  const cached = opts.force ? null : cachedStore(account, await resetAtFor(discordId, account.puuid));
  if (cached) {
    const fresh = await freshStore(cached);
    const store = opts.owned === false ? fresh : await withOwned(fresh, discordId, account, () => tokensFor(discordId, account));
    return { status: 'ok', store, account, cached: true };
  }

  let auth;
  try {
    auth = storage.decrypt(account.auth_encrypted);
  } catch {
    return { status: 'relink', account };
  }

  try {
    const token = await ensureAccessToken(discordId, account.puuid, auth);
    try {
      await items.load();
    } catch (e) {
      console.warn(`[shop] item catalog refresh failed for ${discordId}, using stale copy: ${(e && e.message) || e}`);
    }
    const entitlement = await entitlementFor(token.access_token);
    const tokens = { ...token, entitlement };
    const shard = account.shard || 'na';
    let sf;
    let w;
    {
      const [sfRes, wRes] = await Promise.allSettled([
        riot.storefront(shard, account.puuid, tokens),
        riot.wallet(shard, account.puuid, tokens),
      ]);
      if (sfRes.status === 'fulfilled') {
        sf = sfRes.value;
      } else if (sfRes.reason && sfRes.reason.status === 400 && /version|client/i.test(String(sfRes.reason.message || ''))) {
        riot.resetClientVersion();
        sf = await riot.storefront(shard, account.puuid, tokens);
      } else {
        throw sfRes.reason;
      }
      if (wRes.status === 'fulfilled') {
        w = wRes.value;
      } else {
        w = null;
        console.warn(`[shop] wallet fetch failed for ${discordId}, continuing without balances: ${(wRes.reason && wRes.reason.message) || wRes.reason}`);
      }
    }
    const store = buildStoreResponse(sf, w);
    const panel = sf && sf.SkinsPanelLayout;
    const remainingMs =
      ((panel && (panel.SingleItemOffersRemainingDurationInSeconds || panel.DurationRemainingInSeconds)) || 0) * 1000;
    const resetAt = remainingMs > 0 ? Date.now() + remainingMs : nextMidnightUtc();
    try {
      await storage.kvSet(`shop_reset:${discordId}:${account.puuid}`, { at: resetAt }, 25 * 60 * 60 * 1000);
      await storage.saveAccount(discordId, account.puuid, {
        store_cache: store,
        store_updated_at: new Date().toISOString(),
      });
    } catch (e) {
      console.warn(`[shop] cache persist failed for ${discordId}: ${(e && e.message) || e}`);
    }
    const out = items.refreshIcons(store);
    return {
      status: 'ok',
      store: opts.owned === false ? out : await withOwned(out, discordId, account, async () => tokens),
      account,
    };
  } catch (err) {
    if (err.code === 'RELINK') return { status: 'relink', account };
    return { status: 'error', account, error: err.message };
  }
}

// Discord fast-path: only consult the store cache, never call Riot. The slow
// fetch happens in the follow-up invocation so the interaction stays snappy.
// Pass `account` when it is already loaded (e.g. the accounts list) to avoid a
// redundant read of the same row.
async function cachedStoreFor(discordId, puuid, account) {
  const acct = account || (await storage.getAccount(discordId, puuid));
  if (!acct) return { status: 'unlinked' };
  let resetAt = resetAtFromStore(acct.store_cache);
  if (!resetAt) resetAt = await resetAtFor(discordId, acct.puuid);
  const cached = cachedStore(acct, resetAt);
  if (cached) return { status: 'ok', store: cached, account: acct, cached: true };
  return { status: 'stale', account: acct };
}

// ---- Account details (rank, level, owned skins) ------------------------------
// Rank/level come from the unofficial PD endpoints, owned skins from the PD
// entitlements list (the same list the store checks). Every call is optional:
// whatever does not come back is simply left out. Results are cached in kv for
// 10 minutes so the details modal stays off the hot path.
const DETAILS_TTL = 10 * 60 * 1000;

function summarizeRank(mmr) {
  if (!mmr || typeof mmr !== 'object') return null;
  const latest = mmr.LatestCompetitiveUpdate || {};
  const tier = Number(latest.TierAfterUpdate || 0);
  const rr = Number(latest.RankedRatingAfterUpdate || 0);
  const seasons =
    (mmr.QueueSkills && mmr.QueueSkills.competitive && mmr.QueueSkills.competitive.SeasonalInfoBySeasonID) || {};
  // Peak: CompetitiveTier is only the tier an act ended on, so a player who
  // climbed to Ascendant 3 and dropped back to Ascendant 2 would show A2.
  // WinsByTier is keyed by every tier the player won a game at, which catches
  // the in-act high point. Take the max of both across all acts.
  let peakTier = tier;
  for (const s of Object.values(seasons)) {
    if (!s) continue;
    const tiers = [Number(s.CompetitiveTier), ...Object.keys(s.WinsByTier || {}).map(Number)];
    for (const t of tiers) {
      if (Number.isFinite(t) && t > peakTier) peakTier = t;
    }
  }
  // Immortal+ players get a global leaderboard rank for the active act.
  const seasonInfo = (latest.SeasonID && seasons[latest.SeasonID]) || null;
  const leaderboard = Number((seasonInfo && seasonInfo.LeaderboardRank) || 0) || 0;
  return { tier, rr, peakTier, leaderboard };
}

// Riot returns owned items grouped by item type:
//   { EntitlementsByTypes: [{ ItemTypeID, Entitlements: [{ TypeID, ItemID }] }] }
// Older/other shapes return a flat { Entitlements: [...] }. Accept both.
function entitlementList(res) {
  if (!res) return [];
  if (Array.isArray(res.Entitlements)) return res.Entitlements;
  const out = [];
  for (const group of res.EntitlementsByTypes || []) {
    if (group && Array.isArray(group.Entitlements)) out.push(...group.Entitlements);
  }
  return out;
}

// Owned weapon skins from the entitlements list. Each skin has several level
// UUIDs, so entries are deduped by display name to count actual skins. Also
// buckets them into standard / limited / battle pass for /collection.
function ownedSkins(res) {
  const list = entitlementList(res);
  const seen = new Set();
  const out = [];
  const kinds = { standard: 0, limited: 0, battlepass: 0, agent: 0 };
  for (const e of list) {
    if (!e || !e.ItemID) continue;
    const r = items.resolve(e.ItemID);
    if (r.type !== 'skin') continue;
    const key = items.normalizeName(r.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const kind = items.skinKind(r.name, r.tier, r.edition);
    kinds[kind] += 1;
    out.push({ id: r.id, name: r.name, icon: r.icon, tier: r.tier, kind, category: r.category || null, weapon: r.weapon || null });
    if (out.length >= 800) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { count: out.length, items: out, kinds };
}

// Owned collectibles (cards / sprays / buddies / flexes) from the same entitlements
// list. Deduped by display name like skins; each entry keeps both its animated
// (gif) and static icon where the type has them.
function ownedAccessories(res, type) {
  const list = entitlementList(res);
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (!e || !e.ItemID) continue;
    const r = items.resolve(e.ItemID);
    if (r.type !== type) continue;
    const key = items.normalizeName(r.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: r.id, name: r.name, icon: r.icon, staticIcon: r.staticIcon || null, tier: r.tier || null, art: r.art || null });
    if (out.length >= 600) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// The player's currently equipped personalization (identity card + title,
// spray wheel, primary gun skin) from the unofficial loadout endpoint. Shapes
// are undocumented; every field is mapped defensively and failures are optional.
function equippedFromLoadout(loadout) {
  if (!loadout || typeof loadout !== 'object') return { identityCard: null, identityTitle: null, sprays: [] };
  const id = loadout.Identity || {};
  const out = { identityCard: null, identityTitle: null, sprays: [] };
  const seen = new Set();
  for (const s of loadout.Sprays || []) {
    const r = s && s.SprayID ? items.resolve(s.SprayID) : null;
    if (!r || r.type !== 'spray') continue;
    const key = items.normalizeName(r.name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.sprays.push({ id: r.id, name: r.name, icon: r.icon, staticIcon: r.staticIcon || null });
  }
  if (id.PlayerCard) {
    const r = items.resolve(id.PlayerCard);
    if (r.type === 'card') {
      out.identityCard = { id: r.id, name: r.name, icon: r.icon, art: r.art || null };
    }
  }
  if (id.PlayerTitle) {
    const r = items.resolve(id.PlayerTitle);
    if (r.type === 'title') out.identityTitle = { id: r.id, name: r.name };
  }
  return out;
}

// Returns { status: 'unlinked' | 'ok' | 'relink' | 'error', details?, account? }
async function accountDetails(discordId, puuid) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account) return { status: 'unlinked' };

  const cacheKey = `acctdetails:v9:${discordId}:${account.puuid}`;
  const box = await storage.kvGet(cacheKey).catch(() => null);
  if (box && box.details && box.at && Date.now() - box.at < DETAILS_TTL) {
    return { status: 'ok', details: box.details, cached: true, account };
  }

  let auth;
  try {
    auth = storage.decrypt(account.auth_encrypted);
  } catch {
    return { status: 'relink', account };
  }

  try {
    const token = await ensureAccessToken(discordId, account.puuid, auth);
    const entitlement = await entitlementFor(token.access_token);
    const tokens = { ...token, entitlement };
    const shard = account.shard || 'na';

    // The catalog turns raw entitlement UUIDs into skins with names and icons.
    try {
      await items.load();
    } catch (e) {
      console.warn(`[shop] item catalog refresh failed for details ${discordId}: ${(e && e.message) || e}`);
    }

    const [mmrRes, xpRes, entRes, loadoutRes] = await Promise.allSettled([
      riot.mmr(shard, account.puuid, tokens),
      riot.accountXp(shard, account.puuid, tokens),
      riot.accountEntitlements(shard, account.puuid, tokens),
      riot.playerLoadout(shard, account.puuid, tokens),
    ]);

    if (mmrRes.status === 'rejected' && mmrRes.reason && mmrRes.reason.status === 401) {
      const err = new Error('Riot session expired.');
      err.code = 'RELINK';
      throw err;
    }

    const details = {
      puuid: account.puuid,
      name: account.name || account.label || null,
      shard,
      level: null,
      rank: null,
      skins: { count: 0, items: [], kinds: { standard: 0, agent: 0, limited: 0, battlepass: 0 } },
      cards: [],
      sprays: [],
      buddies: [],
      flexes: [],
      equipped: { identityCard: null, identityTitle: null, sprays: [] },
      updatedAt: Date.now(),
      partial: mmrRes.status !== 'fulfilled' || xpRes.status !== 'fulfilled',
    };

    if (xpRes.status === 'fulfilled') {
      const p = (xpRes.value && xpRes.value.Progress) || {};
      const level = Number(p.Level || 0);
      if (level) details.level = { level };
    }

    if (mmrRes.status === 'fulfilled') {
      details.rank = summarizeRank(mmrRes.value);
      await items.competitiveTiers().catch(() => {});
      if (details.rank && details.rank.tier != null) {
        const t = items.rankTier(details.rank.tier);
        if (t) {
          details.rank.tierName = t.name;
          details.rank.icon = t.icon;
          details.rank.color = t.color;
        }
      }
      if (details.rank && details.rank.peakTier != null) {
        const pt = items.rankTier(details.rank.peakTier);
        if (pt) {
          details.rank.peakName = pt.name;
          details.rank.peakIcon = pt.icon;
        }
      }
    }

    if (entRes.status === 'fulfilled') {
      details.skins = ownedSkins(entRes.value);
      details.cards = ownedAccessories(entRes.value, 'card');
      details.sprays = ownedAccessories(entRes.value, 'spray');
      details.buddies = ownedAccessories(entRes.value, 'buddy');
      details.flexes = ownedAccessories(entRes.value, 'flex');
    }
    if (loadoutRes.status === 'fulfilled') {
      details.equipped = equippedFromLoadout(loadoutRes.value);
      if (process.env.DETAIL_DEBUG) {
        console.log('[shop] loadout raw:', JSON.stringify(loadoutRes.value).slice(0, 2000));
      }
    } else if (loadoutRes.status === 'rejected' && process.env.DETAIL_DEBUG) {
      console.log('[shop] loadout failed:', loadoutRes.reason && loadoutRes.reason.message, loadoutRes.reason && loadoutRes.reason.status);
    }

    // Only cache a fully loaded result. A transient entitlements failure would
    // otherwise freeze an empty "owned skins" list for the whole TTL window.
    if (entRes.status === 'fulfilled') {
      await storage.kvSet(cacheKey, { at: Date.now(), details }, DETAILS_TTL).catch(() => {});
    }
    return { status: 'ok', details, account };
  } catch (err) {
    if (err.code === 'RELINK') return { status: 'relink', account };
    return { status: 'error', account, error: err.message };
  }
}

// ---- Featured bundles: resilient global cache --------------------------------
// The featured bundles are the same for everyone, but the live source depends on
// one account (BUNDLE_SOURCE_ID). If that account ever needs a re-link, every
// user would lose bundles at once. So we remember the last good bundle list in
// kv and fall back to it (or any other account's cached store) when the source
// is unavailable. Bundle entries carry `leavesAt`, so callers still filter out
// expired ones.
const BUNDLES_TTL = 30 * 24 * 60 * 60 * 1000;

async function rememberBundles(bundles) {
  if (!Array.isArray(bundles) || !bundles.length) return;
  await storage.kvSet('bundles:latest', { bundles, at: Date.now() }, BUNDLES_TTL).catch(() => {});
}

async function latestBundles() {
  const box = await storage.kvGet('bundles:latest').catch(() => null);
  return box && Array.isArray(box.bundles) ? box.bundles : [];
}

// Middle fallback: any linked account's cached storefront may already hold a
// fresh bundle list, so scan before resorting to the kv snapshot.
async function anyCachedBundles() {
  const accounts = await storage.listAccounts().catch(() => []);
  const now = Date.now();
  let best = [];
  for (const a of accounts) {
    const b = a && a.store_cache && a.store_cache.bundles;
    if (!Array.isArray(b) || !b.length) continue;
    if (b.some((x) => x && x.leavesAt > now)) return b;
    if (!best.length) best = b;
  }
  return best.length ? best : latestBundles();
}

module.exports = { getShop, cachedStoreFor, accountDetails, renewTokens, refreshTokens: lockedRefresh, STORE_TTL, rememberBundles, latestBundles, anyCachedBundles };