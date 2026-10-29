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
const RENEW_BUDGET_MS = 25 * 1000;
async function renewTokens(auth, opts = {}) {
  if (!auth || !auth.refresh_token) {
    const err = new Error('Riot session expired.');
    err.code = 'REVOKED';
    throw err;
  }
  const attempts = opts.retries == null ? 2 : opts.retries;
  const budgetEnd = Date.now() + RENEW_BUDGET_MS;
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
      // Stay well inside the function limit: no new attempt once the budget is spent.
      if (i < attempts && Date.now() + 500 * (i + 1) < budgetEnd) await sleep(500 * (i + 1));
      else break;
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

// The old refresh token is spent the moment Riot answers, so losing the new one means
// the account silently needs re-linking. A failed save is retried a few times, and the
// admin is pinged if it still fails.
async function persistAuth(discordId, puuid, auth) {
  const delays = [0, 300, 1000];
  let lastErr = null;
  for (const wait of delays) {
    if (wait) await sleep(wait);
    try {
      await storage.saveAccount(discordId, puuid, { auth_encrypted: storage.encrypt(auth) });
      return true;
    } catch (e) {
      lastErr = e;
    }
  }
  const msg = (lastErr && lastErr.message) || String(lastErr);
  console.error(`[shop] token persist failed for ${discordId} after ${delays.length} tries: ${msg}`);
  try {
    require('./discord/log')
      .sendLog(`${require('./discord/log').adminMention()} could not save renewed Riot tokens for ${require('./discord/log').userMention(discordId)} (${String(msg).slice(0, 120)}). The account may need re-linking.`, { ping: true })
      .catch(() => {});
  } catch {
    /* logging is best effort */
  }
  return false;
}

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
        await persistAuth(discordId, puuid, {
          ...base,
          access_token: next.access_token,
          id_token: next.id_token,
          expires_at: next.expires_at,
          refresh_token: next.refresh_token,
        });
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
  await persistAuth(discordId, puuid, auth);
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
    !hasUnknownItems(account.store_cache) &&
    account.store_updated_at &&
    Date.now() - account.store_updated_at < STORE_TTL &&
    (!resetAt || Date.now() < resetAt)
  ) {
    return account.store_cache;
  }
  return null;
}

// Items the catalog could not name ("Unknown Item") mean the store was built while
// the item catalog was missing or partial. Such a store is never cached or reused.
function hasUnknownItems(store) {
  for (const box of [store && store.daily, store && store.kingdomShop, store && store.nightMarket]) {
    for (const it of (box && box.items) || []) if (it && it.type === 'unknown') return true;
  }
  return false;
}

// The balances are all null only when the wallet request failed (a real wallet
// always lists at least VP and Radianite). A cached store like that gets its
// wallet fetched again on its own (see healWallet), never the whole shop.
const WALLET_RETRY_MS = 3 * 60 * 1000;
function walletMissing(store) {
  const w = store && store.wallet;
  return !w || (w.vp == null && w.rp == null && w.kc == null);
}

// The wallet is optional for the shop, but a failure used to leave the balances
// blank until the shop rotated. Retry a couple of times (Riot answers 429 or
// 5xx when the storefront and wallet calls land together), and log why it failed.
async function fetchWallet(shard, puuid, tokens, who) {
  let last = null;
  const budgetEnd = Date.now() + 20 * 1000;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    try {
      return await riot.wallet(shard, puuid, tokens);
    } catch (e) {
      last = e;
      // Only a quick failure is worth another try: not a timeout, not a 4xx, and not past the budget.
      if (e && e.code === 'TIMEOUT') break;
      if (e && e.status && e.status < 500 && e.status !== 429 && e.status !== 408) break;
      if (Date.now() > budgetEnd) break;
    }
  }
  const body = last && last.riotBody ? ` body=${JSON.stringify(last.riotBody).slice(0, 200)}` : '';
  console.warn(`[shop] wallet fetch failed for ${who} shard=${shard} status=${(last && last.status) || '-'} err=${(last && last.message) || last}${body}`);
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
const OWNED_DEADLINE_MS = 5000;
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
      // The owned marks are a nicety: never let this lookup hold the shop for long.
      const lookup = (async () => {
        const tokens = await getTokens();
        return riot.accountEntitlements(account.shard || 'na', account.puuid, tokens);
      })();
      lookup.catch(() => {});
      let timer;
      const res = await Promise.race([
        lookup,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`owned lookup took longer than ${OWNED_DEADLINE_MS}ms`)), OWNED_DEADLINE_MS);
        }),
      ]).finally(() => clearTimeout(timer));
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

// A cached store whose wallet is blank: ask Riot for just the wallet and patch the
// cache. At most one attempt per account every WALLET_RETRY_MS (kept in kv, so it
// also holds across serverless instances), so a wallet that keeps failing costs
// one extra call every few minutes however many accounts there are.
async function healWallet(discordId, account, store) {
  if (!walletMissing(store) || !account.auth_encrypted) return store;
  const gate = `wallet_retry:${discordId}:${account.puuid}`;
  try {
    if (await storage.kvGet(gate)) return store;
    await storage.kvSet(gate, { at: Date.now() }, WALLET_RETRY_MS);
    const tokens = await tokensFor(discordId, account);
    const w = await fetchWallet(account.shard || 'na', account.puuid, tokens, `${discordId}/${account.puuid}`);
    if (!w) return store;
    const { wallet } = buildStoreResponse(null, w);
    if (walletMissing({ wallet })) return store;
    const patched = { ...account.store_cache, wallet };
    await storage.saveAccount(discordId, account.puuid, { store_cache: patched });
    return { ...store, wallet };
  } catch (e) {
    console.warn(`[shop] wallet heal skipped for ${discordId}/${account.puuid}: ${(e && e.message) || e}`);
    return store;
  }
}

// Gets an account ready for an imminent forced fetch: a fresh access token (and its
// entitlement) and the item catalog. Used by the scheduler a minute before the hourly
// bundle check, so the check itself starts from a warm instance and a valid token.
async function warmAccount(discordId, puuid) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account || !account.auth_encrypted) return false;
  const results = await Promise.allSettled([items.load(), tokensFor(discordId, account)]);
  return results.every((r) => r.status === 'fulfilled');
}

// Returns { status: 'unlinked' | 'ok' | 'relink' | 'error', store?, account?, error? }
// Omit puuid to use the user's default account. Pass `owned: false` when the
// caller only needs the store itself (e.g. bundles) to skip the ownership lookup.
async function getShop(discordId, puuid, opts = {}) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account) return { status: 'unlinked' };

  const tStart = Date.now();
  const cached = opts.force ? null : cachedStore(account, await resetAtFor(discordId, account.puuid));
  if (cached) {
    const tCached = Date.now();
    const fresh = await healWallet(discordId, account, await freshStore(cached));
    const tFresh = Date.now();
    const store = opts.owned === false ? fresh : await withOwned(fresh, discordId, account, () => tokensFor(discordId, account));
    console.log(`[time] getShop cached lookup=${tCached - tStart}ms catalog+wallet=${tFresh - tCached}ms owned=${Date.now() - tFresh}ms`);
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
        fetchWallet(shard, account.puuid, tokens, `${discordId}/${account.puuid}`),
      ]);
      if (sfRes.status === 'fulfilled') {
        sf = sfRes.value;
      } else if (sfRes.reason && sfRes.reason.status === 400 && /version|client/i.test(String(sfRes.reason.message || ''))) {
        riot.resetClientVersion();
        sf = await riot.storefront(shard, account.puuid, tokens);
      } else {
        throw sfRes.reason;
      }
      w = wRes.status === 'fulfilled' ? wRes.value : null;
    }
    let store = buildStoreResponse(sf, w);
    // Catalog was incomplete when the store was built: reload it once and rebuild.
    if (hasUnknownItems(store)) {
      try {
        await items.load(true);
        store = buildStoreResponse(sf, w);
      } catch (e) {
        console.warn(`[shop] catalog reload failed for ${discordId}: ${(e && e.message) || e}`);
      }
    }
    // Wallet failed this time: keep the last balances we knew rather than blanking them.
    if (!w && walletMissing(store) && !walletMissing(account.store_cache)) store.wallet = account.store_cache.wallet;
    const panel = sf && sf.SkinsPanelLayout;
    const remainingMs =
      ((panel && (panel.SingleItemOffersRemainingDurationInSeconds || panel.DurationRemainingInSeconds)) || 0) * 1000;
    const resetAt = remainingMs > 0 ? Date.now() + remainingMs : nextMidnightUtc();
    try {
      await storage.kvSet(`shop_reset:${discordId}:${account.puuid}`, { at: resetAt }, 25 * 60 * 60 * 1000);
      if (hasUnknownItems(store)) {
        console.warn(`[shop] store for ${discordId} has unresolved items (catalog incomplete), not caching it`);
      } else {
        await storage.saveAccount(discordId, account.puuid, {
          store_cache: store,
          store_updated_at: new Date().toISOString(),
        });
      }
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

// Owned collectibles (cards / sprays / buddies / titles / flexes) from the same entitlements
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
  // Riot's field names end in "ID"; older notes had them without it.
  const cardId = id.PlayerCardID || id.PlayerCard;
  const titleId = id.PlayerTitleID || id.PlayerTitle;
  if (cardId) {
    const r = items.resolve(cardId);
    if (r.type === 'card') {
      out.identityCard = { id: r.id, name: r.name, icon: r.icon, art: r.art || null };
    }
  }
  if (titleId) {
    const r = items.resolve(titleId);
    if (r.type === 'title') out.identityTitle = { id: r.id, name: r.name };
  }
  return out;
}

// Returns { status: 'unlinked' | 'ok' | 'relink' | 'error', details?, account? }
// `scope` limits what is asked of Riot: 'rank' reads only the rank and level, and
// 'collection' only the owned items. The bot commands use these so /rank does not
// wait on the (large) entitlements list and /collection not on the rank lookups.
// A fully loaded copy in the cache serves every scope.
async function accountDetails(discordId, puuid, opts = {}) {
  const scope = opts.scope === 'rank' || opts.scope === 'collection' ? opts.scope : 'full';
  const account = await storage.getAccount(discordId, puuid);
  if (!account) return { status: 'unlinked' };

  const fullKey = `acctdetails:v12:${discordId}:${account.puuid}`;
  const cacheKey = scope === 'full' ? fullKey : `acctdetails:v12:${scope}:${discordId}:${account.puuid}`;
  // The scoped copy is the small one: try it first, and only read the big full copy
  // (hundreds of KB) when it misses.
  const fresh = (box) => box && box.details && box.at && Date.now() - box.at < DETAILS_TTL;
  const scopedBox = scope === 'full' ? null : await storage.kvGet(cacheKey).catch(() => null);
  if (fresh(scopedBox)) return { status: 'ok', details: scopedBox.details, cached: true, account };
  const fullBox = await storage.kvGet(fullKey).catch(() => null);
  if (fresh(fullBox)) return { status: 'ok', details: fullBox.details, cached: true, account };

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

    // The catalog turns raw entitlement UUIDs into skins with names and icons
    // (the rank lookup does not need it).
    if (scope !== 'rank') {
      try {
        await items.load();
      } catch (e) {
        console.warn(`[shop] item catalog refresh failed for details ${discordId}: ${(e && e.message) || e}`);
      }
    }

    const skipped = Promise.resolve({ __skipped: true });
    const want = (part) => scope === 'full' || scope === part;
    const [mmrRes, xpRes, entRes, loadoutRes] = await Promise.allSettled([
      want('rank') ? riot.mmr(shard, account.puuid, tokens) : skipped,
      want('rank') ? riot.accountXp(shard, account.puuid, tokens) : skipped,
      want('collection') ? riot.accountEntitlements(shard, account.puuid, tokens) : skipped,
      scope === 'full' ? riot.playerLoadout(shard, account.puuid, tokens) : skipped,
    ]);
    const ran = (r) => r.status !== 'fulfilled' || !(r.value && r.value.__skipped);
    const okRes = (r) => r.status === 'fulfilled' && ran(r);

    const expired = [mmrRes, entRes].some((r) => r.status === 'rejected' && r.reason && r.reason.status === 401);
    if (expired) {
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
      titles: [],
      flexes: [],
      equipped: { identityCard: null, identityTitle: null, sprays: [] },
      updatedAt: Date.now(),
      partial: scope === 'full' && (mmrRes.status !== 'fulfilled' || xpRes.status !== 'fulfilled'),
    };

    if (okRes(xpRes)) {
      const p = (xpRes.value && xpRes.value.Progress) || {};
      const level = Number(p.Level || 0);
      if (level) details.level = { level };
    }

    if (okRes(mmrRes)) {
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

    if (okRes(entRes)) {
      details.skins = ownedSkins(entRes.value);
      details.cards = ownedAccessories(entRes.value, 'card');
      details.sprays = ownedAccessories(entRes.value, 'spray');
      details.buddies = ownedAccessories(entRes.value, 'buddy');
      details.titles = ownedAccessories(entRes.value, 'title');
      details.flexes = ownedAccessories(entRes.value, 'flex');
    }
    if (okRes(loadoutRes)) {
      details.equipped = equippedFromLoadout(loadoutRes.value);
      if (process.env.DETAIL_DEBUG) {
        console.log('[shop] loadout raw:', JSON.stringify(loadoutRes.value).slice(0, 2000));
      }
    } else if (loadoutRes.status === 'rejected') {
      // Optional data, but a silent failure hid a wrong path for a long time.
      console.warn(`[shop] loadout failed for ${discordId}: ${loadoutRes.reason && loadoutRes.reason.message} (${loadoutRes.reason && loadoutRes.reason.status})`);
    }

    // Only cache a fully loaded result. A transient entitlements failure would
    // otherwise freeze an empty "owned skins" list for the whole TTL window.
    const loaded = scope === 'rank' ? okRes(mmrRes) : okRes(entRes);
    if (loaded) {
      await storage.kvSet(cacheKey, { at: Date.now(), details }, DETAILS_TTL).catch(() => {});
    }
    return { status: 'ok', details, account };
  } catch (err) {
    if (err.code === 'RELINK') return { status: 'relink', account };
    return { status: 'error', account, error: err.message };
  }
}

// ---- Full loadout (every weapon, card, title, sprays, flexes) -----------------
// Backs the dashboard's Loadout page. Riot's loadout response is undocumented, so every
// field is read defensively and anything that does not resolve is left out.
const LOADOUT_TTL = 5 * 60 * 1000;
const lowerId = (v) => String(v || '').toLowerCase();

async function buildLoadout(raw) {
  const out = { card: null, title: null, level: null, levelHidden: false, incognito: false, guns: [], sprays: [], flexes: [], expressions: [] };
  const identity = (raw && raw.Identity) || {};
  const cardId = identity.PlayerCardID || identity.PlayerCard;
  if (cardId) {
    const r = items.resolve(cardId);
    if (r.type === 'card') out.card = { id: r.id, name: r.name, icon: r.icon, art: r.art || null };
  }
  const titleId = identity.PlayerTitleID || identity.PlayerTitle;
  if (titleId) {
    const r = items.resolve(titleId);
    if (r.type === 'title') out.title = { id: r.id, name: r.name };
  }
  if (Number.isFinite(Number(identity.AccountLevel))) out.level = Number(identity.AccountLevel);
  out.levelHidden = Boolean(identity.HideAccountLevel);
  out.incognito = Boolean(raw && raw.Incognito);

  for (const g of (raw && raw.Guns) || []) {
    const skinKey = g && (g.SkinID || g.SkinLevelID);
    if (!skinKey) continue;
    const skin = await items.details(skinKey).catch(() => null);
    if (!skin || skin.type !== 'skin') continue;
    const chromas = skin.chromas || [];
    const chromaIdx = chromas.findIndex((c) => lowerId(c.id) === lowerId(g.ChromaID));
    const chroma = chromaIdx >= 0 ? chromas[chromaIdx] : null;
    const levels = skin.levels || [];
    const levelIdx = levels.findIndex((l) => lowerId(l.id) === lowerId(g.SkinLevelID));
    const charm = g.CharmLevelID || g.CharmID ? items.resolve(g.CharmLevelID || g.CharmID) : null;
    out.guns.push({
      weapon: skin.weapon || String(skin.name || '').replace(/^Standard\s+/i, '') || null,
      category: skin.category || null,
      skin: {
        id: skin.id,
        name: skin.name,
        tier: skin.tier || null,
        tierIcon: skin.tierIcon || null,
        icon: skin.icon || null,
        render: (chroma && chroma.render) || skin.render || skin.icon || null,
        swatch: chromaIdx > 0 ? chroma.swatch || null : null,
        variant: chromaIdx > 0 ? chromaIdx + 1 : null,
        level: levelIdx >= 0 ? levelIdx + 1 : null,
        levels: levels.length || null,
        random: /random favorite/i.test(skin.name || ''),
      },
      buddy: charm && charm.type === 'buddy' ? { id: charm.id, name: charm.name, icon: charm.icon } : null,
    });
  }

  // Older responses list sprays under `Sprays`; newer ones put sprays and flexes in
  // `ActiveExpressions` as { TypeID, AssetID }. Read both and keep what resolves.
  const seen = new Set();
  const expressionIds = [
    ...((raw && raw.Sprays) || []).map((x) => x && x.SprayID),
    ...((raw && raw.ActiveExpressions) || []).map((x) => x && x.AssetID),
  ];
  for (const rawId of expressionIds) {
    const r = rawId ? items.resolve(rawId) : null;
    if (!r || (r.type !== 'spray' && r.type !== 'flex')) continue;
    const key = `${r.type}:${lowerId(r.id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = { id: r.id, name: r.name, icon: r.icon, staticIcon: r.staticIcon || null };
    (r.type === 'spray' ? out.sprays : out.flexes).push(entry);
    // The wheel has four slots; this keeps them in the order Riot lists them.
    out.expressions.push({ ...entry, kind: r.type });
  }
  if (!out.sprays.length && !out.flexes.length) {
    console.log(`[shop] loadout has no sprays or flexes; fields: ${Object.keys(raw || {}).join(',')}`);
  }
  return out;
}

// Returns { status: 'unlinked' | 'ok' | 'relink' | 'error', loadout?, account? }
async function accountLoadout(discordId, puuid) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account) return { status: 'unlinked' };
  const cacheKey = `loadout:v2:${discordId}:${account.puuid}`;
  const box = await storage.kvGet(cacheKey).catch(() => null);
  if (box && box.loadout && box.at && Date.now() - box.at < LOADOUT_TTL) {
    return { status: 'ok', loadout: box.loadout, cached: true, account };
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
    await items.load().catch(() => {});
    const raw = await riot.playerLoadout(account.shard || 'na', account.puuid, tokens);
    const loadout = await buildLoadout(raw);
    await storage.kvSet(cacheKey, { at: Date.now(), loadout }, LOADOUT_TTL).catch(() => {});
    return { status: 'ok', loadout, account };
  } catch (err) {
    if (err.code === 'RELINK' || err.status === 401) return { status: 'relink', account };
    return { status: 'error', account, error: err.message };
  }
}

// ---- Battle pass progress -----------------------------------------------------
// Where an account is on the current act's battle pass. The tier comes straight from
// the contracts call; the premium track counts as bought when the account owns the
// pass's first premium reward (buying the pass grants it at once). XP only moves after
// matches, so a result is kept for a few minutes.
const BATTLEPASS_TTL = 10 * 60 * 1000;

async function accountBattlepass(discordId, puuid) {
  const account = await storage.getAccount(discordId, puuid);
  if (!account) return { status: 'unlinked' };
  const cacheKey = `battlepass:v1:${discordId}:${account.puuid}`;
  const box = await storage.kvGet(cacheKey).catch(() => null);
  if (box && box.progress && box.at && Date.now() - box.at < BATTLEPASS_TTL) {
    return { status: 'ok', progress: box.progress, cached: true, account };
  }
  let auth;
  try {
    auth = storage.decrypt(account.auth_encrypted);
  } catch {
    return { status: 'relink', account };
  }
  try {
    const meta = await items.battlepassMeta();
    if (!meta) return { status: 'ok', progress: null, account };
    const token = await ensureAccessToken(discordId, account.puuid, auth);
    const entitlement = await entitlementFor(token.access_token);
    const tokens = { ...token, entitlement };
    const shard = account.shard || 'na';
    const premiumKey = `battlepass:premium:${discordId}:${account.puuid}:${meta.contractId}`;
    const premiumKnown = Boolean(await storage.kvGet(premiumKey).catch(() => null));
    const [contracts, owned] = await Promise.all([
      riot.contracts(shard, account.puuid, tokens),
      premiumKnown ? null : riot.accountEntitlements(shard, account.puuid, tokens).catch(() => null),
    ]);
    const mine = ((contracts && contracts.Contracts) || []).find((c) => String(c.ContractDefinitionID).toLowerCase() === meta.contractId);
    const tier = mine ? Number(mine.ProgressionLevelReached) || 0 : 0;
    const towards = mine ? Number(mine.ProgressionTowardsNextLevel) || 0 : 0;
    let premium = null; // unknown when the ownership list did not come back
    if (premiumKnown) premium = true;
    else if (owned && meta.premiumMarker) {
      premium = (owned.EntitlementsByTypes || []).some((t) => (t.Entitlements || []).some((e) => String(e.ItemID).toLowerCase() === meta.premiumMarker));
      // A bought pass stays bought for the whole act, so that is not asked again.
      if (premium) await storage.kvSet(premiumKey, true, 120 * 24 * 60 * 60 * 1000).catch(() => {});
    }
    const progress = {
      tier,
      towards,
      // XP the next tier asks for; the tier list is 0-based, so the next tier's entry is meta.xp[tier].
      nextXp: tier < meta.xp.length ? meta.xp[tier] : null,
      totalTiers: meta.xp.length,
      premium,
    };
    await storage.kvSet(cacheKey, { at: Date.now(), progress }, BATTLEPASS_TTL).catch(() => {});
    return { status: 'ok', progress, account };
  } catch (err) {
    if (err.code === 'RELINK' || err.status === 401) return { status: 'relink', account };
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

module.exports = { getShop, warmAccount, cachedStoreFor, accountDetails, accountLoadout, accountBattlepass, buildLoadout, renewTokens, refreshTokens: lockedRefresh, STORE_TTL, rememberBundles, latestBundles, anyCachedBundles };