'use strict';

const crypto = require('node:crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

let client = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  const { createClient } = require('@supabase/supabase-js');
  client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

const hasDb = Boolean(client);

// ---- AES-256-GCM envelope ---------------------------------------------------
function keyBuffer() {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw) throw new Error('Missing ENCRYPTION_KEY env (refusing to encrypt with an insecure default).');
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return crypto.createHash('sha256').update(String(raw)).digest();
}

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decrypt(str) {
  const [iv, tag, data] = String(str).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const out = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}

// ---- In-memory fallback (local dev without Supabase) ------------------------
const mem = {
  accounts: new Map(),
  kv: new Map(),
  sessions: new Map(),
};

function isConfigured() {
  return hasDb;
}

// ---- Sessions (express-session store) --------------------------------------
// Every website request loads its session, and each page load fires several. A short
// per-instance memo answers the repeats without a round trip, and writes that would
// change nothing (same data, expiry still far away) are skipped.
const SESSION_MEMO_MS = 15 * 1000;
const SESSION_MEMO_MAX = 200;
const SESSION_REFRESH_GAP_MS = 12 * 60 * 60 * 1000; // expiry slides at most this often
const sessionMemo = new Map(); // sid -> { json, expiresAt, at }

function sessionBody(data) {
  return JSON.stringify(data, (k, v) => (k === 'cookie' ? undefined : v));
}

function rememberSession(sid, data, expiresAt) {
  if (sessionMemo.size >= SESSION_MEMO_MAX) sessionMemo.delete(sessionMemo.keys().next().value);
  sessionMemo.set(sid, { json: JSON.stringify(data), body: sessionBody(data), expiresAt, at: Date.now() });
}

async function sessionGet(sid) {
  if (!hasDb) {
    const row = mem.sessions.get(sid);
    if (!row) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      mem.sessions.delete(sid);
      return null;
    }
    return row.data;
  }
  const memo = sessionMemo.get(sid);
  if (memo && Date.now() - memo.at < SESSION_MEMO_MS && memo.expiresAt > Date.now()) return JSON.parse(memo.json);
  const { data, error } = await client.from('sessions').select('data, expires_at').eq('sid', sid).maybeSingle();
  if (error) dbFail('session get', error);
  if (!data) {
    sessionMemo.delete(sid);
    return null;
  }
  const expiresAt = new Date(data.expires_at).getTime();
  if (expiresAt <= Date.now()) {
    sessionMemo.delete(sid);
    await client.from('sessions').delete().eq('sid', sid);
    return null;
  }
  rememberSession(sid, data.data, expiresAt);
  return data.data;
}

async function sessionSet(sid, data, maxAgeMs) {
  const maxAge = Number(maxAgeMs) || 7 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + maxAge).toISOString();
  if (!hasDb) {
    mem.sessions.set(sid, { data, expires_at: expiresAt });
    return;
  }
  const memo = sessionMemo.get(sid);
  if (memo && memo.body === sessionBody(data) && memo.expiresAt - Date.now() > maxAge - SESSION_REFRESH_GAP_MS) return;
  const { error } = await client
    .from('sessions')
    .upsert({ sid, data, expires_at: expiresAt }, { onConflict: 'sid' });
  if (error) dbFail('session set', error);
  rememberSession(sid, data, new Date(expiresAt).getTime());
}

// Extends expiry only. Must never upsert: a request that loaded the session
// before logout would otherwise write it back after sessionDestroy.
async function sessionTouch(sid, maxAgeMs) {
  const maxAge = Number(maxAgeMs) || 7 * 24 * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + maxAge).toISOString();
  if (!hasDb) {
    const row = mem.sessions.get(sid);
    if (row) row.expires_at = expiresAt;
    return;
  }
  // The session was just read, so the memo knows its expiry: a session that was
  // extended within the last half day does not need another write.
  const memo = sessionMemo.get(sid);
  if (memo && memo.expiresAt - Date.now() > maxAge - SESSION_REFRESH_GAP_MS) return;
  const { error } = await client.from('sessions').update({ expires_at: expiresAt }).eq('sid', sid);
  if (error) dbFail('session touch', error);
  if (memo) memo.expiresAt = new Date(expiresAt).getTime();
}

// Drops every website session that belongs to a Discord user (full data wipe).
async function sessionDestroyForUser(discordId) {
  const id = String(discordId);
  sessionMemo.clear();
  if (!hasDb) {
    for (const [sid, row] of mem.sessions.entries()) {
      if (row && row.data && String(row.data.discordId) === id) mem.sessions.delete(sid);
    }
    return;
  }
  const { error } = await client.from('sessions').delete().eq('data->>discordId', id);
  if (error) dbFail('session destroy user', error);
}

async function sessionDestroy(sid) {
  sessionMemo.delete(sid);
  if (!hasDb) {
    mem.sessions.delete(sid);
    return;
  }
  const { error } = await client.from('sessions').delete().eq('sid', sid);
  if (error) dbFail('session destroy', error);
}

// ---- Key-value (pending login states, misc) ---------------------------------
// Big rows (account details, bundle media, the item catalog) are 100s of KB each and
// get read again and again. The raw text of those is kept for a minute per instance,
// so a repeat read costs no egress. Writes and deletes here drop the entry.
const BIG_MIN_CHARS = 50 * 1000;
const BIG_MEMO_MS = 60 * 1000;
const IMMUTABLE_MEMO_MS = 6 * 60 * 60 * 1000; // rendered bundle images never change once saved
const BIG_MEMO_MAX = 12;
const bigMemo = new Map(); // key -> { value, expiresAt, at, ttl }

function rememberBig(key, value, expiresAt) {
  if (bigMemo.size >= BIG_MEMO_MAX) bigMemo.delete(bigMemo.keys().next().value);
  const ttl = key.startsWith('bundle:media:') ? IMMUTABLE_MEMO_MS : BIG_MEMO_MS;
  bigMemo.set(key, { value, expiresAt, at: Date.now(), ttl });
}

// A row with expires_at = null never expires. Pass KV_NO_EXPIRY as the ttl for data that
// must outlive any cache window (settings, share links, the DPoP key). Every reader goes
// through expMs(), because new Date(null).getTime() is 0 and would read as "long expired".
const KV_NO_EXPIRY = null;
const expMs = (v) => (v == null ? Infinity : new Date(v).getTime());

async function kvSet(key, value, ttlMs) {
  bigMemo.delete(key);
  const expiresAt = ttlMs === KV_NO_EXPIRY ? null : new Date(Date.now() + (ttlMs || 15 * 60 * 1000)).toISOString();
  if (!hasDb) {
    mem.kv.set(key, { value, expires_at: expiresAt });
    return;
  }
  const { error: setError } = await client.from('kv').upsert({ key, value: JSON.stringify(value), expires_at: expiresAt }, { onConflict: 'key' });
  if (setError) dbFail('kv set', setError);
}

// Best-effort cross-instance lock on a kv row. Returns true when this caller now
// holds it. The row is inserted (never upserted), so only one insert wins; an
// expired holder is cleared first, so a crashed instance cannot block forever.
async function kvLock(key, ttlMs) {
  const expiresAt = new Date(Date.now() + (ttlMs || 30000)).toISOString();
  if (!hasDb) {
    const row = mem.kv.get(key);
    if (row && expMs(row.expires_at) > Date.now()) return false;
    mem.kv.set(key, { value: JSON.stringify({ at: Date.now() }), expires_at: expiresAt });
    return true;
  }
  await client.from('kv').delete().eq('key', key).lt('expires_at', new Date().toISOString());
  const { error } = await client.from('kv').insert({ key, value: JSON.stringify({ at: Date.now() }), expires_at: expiresAt });
  if (!error) return true;
  if (error.code === '23505') return false; // unique violation: someone else holds it
  dbFail('kv lock', error);
}

// Writes a row only when the key does not exist yet (an expired row counts as absent).
// Returns true when this call created it, false when another writer got there first.
async function kvInsert(key, value, ttlMs) {
  const expiresAt = ttlMs === KV_NO_EXPIRY ? null : new Date(Date.now() + (ttlMs || 15 * 60 * 1000)).toISOString();
  if (!hasDb) {
    const row = mem.kv.get(key);
    if (row && expMs(row.expires_at) > Date.now()) return false;
    mem.kv.set(key, { value, expires_at: expiresAt });
    return true;
  }
  await client.from('kv').delete().eq('key', key).lt('expires_at', new Date().toISOString());
  const { error } = await client.from('kv').insert({ key, value: JSON.stringify(value), expires_at: expiresAt });
  if (!error) return true;
  if (error.code === '23505') return false;
  dbFail('kv insert', error);
}

async function kvUnlock(key) {
  return kvDel(key);
}

async function kvGet(key) {
  const big = bigMemo.get(key);
  if (big && Date.now() - big.at < big.ttl && big.expiresAt > Date.now()) {
    try {
      return JSON.parse(big.value);
    } catch {
      bigMemo.delete(key);
    }
  }
  if (!hasDb) {
    const row = mem.kv.get(key);
    if (!row) return null;
    if (expMs(row.expires_at) <= Date.now()) {
      mem.kv.delete(key);
      return null;
    }
    return row.value;
  }
  const { data, error } = await client.from('kv').select('value, expires_at').eq('key', key).maybeSingle();
  if (error) dbFail('kv get', error);
  if (!data) return null;
  if (expMs(data.expires_at) <= Date.now()) {
    await kvDel(key);
    return null;
  }
  if (typeof data.value === 'string' && data.value.length >= BIG_MIN_CHARS) {
    rememberBig(key, data.value, expMs(data.expires_at));
  }
  try {
    return JSON.parse(data.value);
  } catch {
    return null;
  }
}

// True when the key exists and has not expired. Reads only the expiry, never the value,
// so checking for a big row costs almost nothing.
async function kvExists(key) {
  const big = bigMemo.get(key);
  if (big && Date.now() - big.at < big.ttl && big.expiresAt > Date.now()) return true;
  if (!hasDb) {
    const row = mem.kv.get(key);
    return Boolean(row && expMs(row.expires_at) > Date.now());
  }
  const { data, error } = await client.from('kv').select('expires_at').eq('key', key).maybeSingle();
  if (error) dbFail('kv exists', error);
  return Boolean(data && expMs(data.expires_at) > Date.now());
}

// Drops expired sessions and kv rows (rows with a null expiry are kept). Service role only.
async function cleanupExpired() {
  if (!hasDb) return;
  const { error } = await client.rpc('cleanup_expired');
  if (error) dbFail('cleanup expired', error);
}

async function kvDel(key) {
  bigMemo.delete(key);
  if (!hasDb) {
    mem.kv.delete(key);
    return;
  }
  const { error } = await client.from('kv').delete().eq('key', key);
  if (error) dbFail('kv delete', error);
}

async function kvList(prefix) {
  const p = String(prefix || '');
  if (!hasDb) {
    const out = [];
    for (const [key, row] of mem.kv.entries()) {
      if (key.startsWith(p) && expMs(row.expires_at) > Date.now()) {
        out.push({ key, value: row.value });
      }
    }
    return out;
  }
  const out = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('kv')
      .select('key, value, expires_at')
      .like('key', `${p}%`)
      .range(from, from + PAGE - 1);
    if (error) dbFail('kv list', error);
    if (!data || !data.length) break;
    for (const row of data) {
      if (expMs(row.expires_at) <= Date.now()) continue;
      let value = row.value;
      try {
        value = JSON.parse(row.value);
      } catch {
        /* keep raw string */
      }
      out.push({ key: row.key, value });
    }
    if (data.length < PAGE) break;
  }
  return out;
}

// ---- Accounts (one row per linked Riot account) -----------------------------
// Primary key is (discord_id, puuid). puuid is globally unique per Riot account.
function accountRow(row) {
  if (!row) return null;
  return {
    discord_id: row.discord_id,
    puuid: row.puuid,
    name: row.name,
    label: row.label || row.name || null,
    shard: row.shard,
    is_default: row.is_default === true,
    auth_encrypted: row.auth_encrypted,
    store_cache: row.store_cache,
    store_updated_at: row.store_updated_at ? new Date(row.store_updated_at).getTime() : 0,
    created_at: row.created_at ? new Date(row.created_at).getTime() : 0,
    updated_at: row.updated_at ? new Date(row.updated_at).getTime() : 0,
  };
}

function memAccountKey(discordId, puuid) {
  return `${String(discordId)}:${String(puuid)}`;
}

function pickDefault(rows) {
  if (!rows.length) return null;
  return rows.find((r) => r.is_default) || rows[0];
}

// Omit puuid to get the user's default account (back-compat single-account read).
async function getAccount(discordId, puuid) {
  if (!discordId) return null;
  if (puuid) {
    if (!hasDb) return accountRow(mem.accounts.get(memAccountKey(discordId, puuid)) || null);
    const { data, error } = await client
      .from('accounts')
      .select('*')
      .eq('discord_id', String(discordId))
      .eq('puuid', String(puuid))
      .maybeSingle();
    if (error) dbFail('account get', error);
    return accountRow(data || null);
  }
  return pickDefault(await listAccountsByUser(discordId));
}

// All of a user's accounts, default first, then oldest linked.
async function listAccountsByUser(discordId) {
  if (!discordId) return [];
  let rows;
  if (!hasDb) {
    rows = [...mem.accounts.values()]
      .filter((r) => r && r.discord_id === String(discordId))
      .map(accountRow);
  } else {
    const { data, error } = await client.from('accounts').select('*').eq('discord_id', String(discordId));
    if (error) dbFail('account list user', error);
    rows = (data || []).map(accountRow);
  }
  rows.sort((a, b) => Number(b.is_default) - Number(a.is_default) || (a.created_at - b.created_at));
  return rows;
}

async function saveAccount(discordId, puuid, fields) {
  const row = {
    discord_id: String(discordId),
    puuid: String(puuid),
    updated_at: new Date().toISOString(),
    ...fields,
  };
  if (!hasDb) {
    const prev = mem.accounts.get(memAccountKey(discordId, puuid)) || {};
    mem.accounts.set(memAccountKey(discordId, puuid), { ...prev, ...row });
    return;
  }
  const { error } = await client.from('accounts').upsert(row, { onConflict: 'discord_id,puuid' });
  if (error) dbFail('account save', error);
}

// Omit puuid to delete all of a user's rows.
async function deleteAccount(discordId, puuid) {
  if (!hasDb) {
    if (puuid) {
      mem.accounts.delete(memAccountKey(discordId, puuid));
      return;
    }
    for (const [k, v] of mem.accounts.entries()) {
      if (v && v.discord_id === String(discordId)) mem.accounts.delete(k);
    }
    return;
  }
  let q = client.from('accounts').delete().eq('discord_id', String(discordId));
  if (puuid) q = q.eq('puuid', String(puuid));
  const { error } = await q;
  if (error) dbFail('account delete', error);
}

async function listAccounts() {
  if (!hasDb) {
    return [...mem.accounts.values()].map((row) => ({ ...row }));
  }
  const { data, error } = await client.from('accounts').select('*');
  if (error) dbFail('account list', error);
  return (data || []).map((row) => ({ ...row }));
}

// Public aggregate counts for the website footer: distinct Discord users and
// total linked Riot accounts. Uses an exact head count for the total and a
// paged select of discord_id (deduped in JS) for users, so we never pull the
// whole table. Callers should cache the result; it is not cheap per request.
async function getStats() {
  if (!hasDb) {
    const rows = [...mem.accounts.values()];
    const users = new Set();
    for (const row of rows) if (row && row.discord_id) users.add(String(row.discord_id));
    return { accounts: rows.length, users: users.size };
  }
  const { count, error } = await client.from('accounts').select('*', { count: 'exact', head: true });
  if (error) dbFail('stats count', error);
  const users = new Set();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error: listError } = await client
      .from('accounts')
      .select('discord_id')
      .range(from, from + PAGE - 1);
    if (listError) dbFail('stats users', listError);
    if (!data || !data.length) break;
    for (const row of data) if (row.discord_id) users.add(String(row.discord_id));
    if (data.length < PAGE) break;
  }
  return { accounts: count || 0, users: users.size };
}

// ---- Alert prefs (managed on the website) ------------------------------------
// Shape: { accounts: { [puuid]: { shop, accessory, wishlist_shop, wishlist_accessory } },
//          nm: bool, bundle: bool }.
// Everything defaults to off; the user opts in explicitly.
const PREFS_TTL = 365 * 24 * 60 * 60 * 1000;

// Per-account alert toggles. `wishlist` was the original combined flag; it is
// split into per-scope flags and migrated on read so old prefs keep working.
function normalizeAlert(alert) {
  const a = alert && typeof alert === 'object' ? alert : {};
  const legacy = a.wishlist === true;
  return {
    shop: a.shop === true,
    accessory: a.accessory === true,
    wishlist_shop: a.wishlist_shop === undefined ? legacy : a.wishlist_shop === true,
    wishlist_accessory: a.wishlist_accessory === undefined ? legacy : a.wishlist_accessory === true,
  };
}

async function getPrefs(discordId) {
  const prefs = await kvGet(`alertprefs:${discordId}`).catch(() => null);
  if (prefs && typeof prefs === 'object') {
    const raw = prefs.accounts && typeof prefs.accounts === 'object' ? prefs.accounts : {};
    const accounts = {};
    for (const [puuid, alert] of Object.entries(raw)) accounts[puuid] = normalizeAlert(alert);
    return {
      accounts,
      nm: prefs.nm === true,
      bundle: prefs.bundle === true,
      wishlist_nm: prefs.wishlist_nm === true,
      nm_names: prefs.nm_names === true,
      order: Array.isArray(prefs.order) ? prefs.order : [],
    };
  }
  return { accounts: {}, nm: false, bundle: false, wishlist_nm: false, nm_names: false, order: [] };
}

async function setPrefs(discordId, prefs) {
  await kvSet(`alertprefs:${discordId}`, prefs, PREFS_TTL);
}

// ---- Wishlist (per Discord user, not per account) ---------------------------
// Shape: { daily: WishItem[], accessory: WishItem[] }. WishItem is a catalog
// snapshot: { id, name, type, icon, art?, kind, addedAt }. Everything defaults
// to empty; the user opts in explicitly.
const WISHLIST_TTL = 365 * 24 * 60 * 60 * 1000;

function wishlistItem(row) {
  if (!row || !row.id) return null;
  return {
    id: String(row.id),
    name: String(row.name || 'Unknown'),
    type: row.type || 'unknown',
    icon: row.icon || null,
    art: row.art || null,
    kind: row.kind === 'accessory' ? 'accessory' : 'daily',
    addedAt: Number(row.addedAt) || 0,
  };
}

async function getWishlist(discordId) {
  const raw = await kvGet(`wishlist:${discordId}`).catch(() => null);
  const box = raw && typeof raw === 'object' ? raw : {};
  const clean = (list) => (Array.isArray(list) ? list.map(wishlistItem).filter(Boolean) : []);
  return { daily: clean(box.daily), accessory: clean(box.accessory) };
}

async function setWishlist(discordId, wishlist) {
  const box = wishlist && typeof wishlist === 'object' ? wishlist : {};
  const prev = await getWishlist(discordId).catch(() => ({ daily: [], accessory: [] }));
  const pick = (list, fallback) => (Array.isArray(list) ? list.map(wishlistItem).filter(Boolean) : fallback);
  const next = {
    daily: pick(box.daily, prev.daily),
    accessory: pick(box.accessory, prev.accessory),
  };
  await kvSet(`wishlist:${discordId}`, next, WISHLIST_TTL);
  return next;
}

// ---- Account sharing ---------------------------------------------------------
// A share code is a bearer capability: whoever holds it can import one Riot
// account as a read-only "shared" card. Recipients never receive the owner's
// Riot tokens - shared shops are served from the owner's own stored session.
// Codes are persisted only as an HMAC digest, so a database dump does not leak
// usable codes, and stay valid until the owner revokes them.
const SHARE_TTL = 3650 * 24 * 60 * 60 * 1000; // ~10 years (i.e. until revoked)

function hashShareCode(code) {
  return crypto.createHmac('sha256', keyBuffer()).update(`valshops:share:${String(code)}`).digest('hex');
}

async function getShare(digest) {
  return kvGet(`share:code:${digest}`).catch(() => null);
}

async function putShare(digest, record) {
  await kvSet(`share:code:${digest}`, record, SHARE_TTL);
}

async function delShare(digest) {
  await kvDel(`share:code:${digest}`);
}

// Codes an owner has created, keyed by puuid: { [puuid]: { code, name, shard, created_at } }
async function getOwnerShares(discordId) {
  const box = await kvGet(`share:owner:${discordId}`).catch(() => null);
  return box && box.items && typeof box.items === 'object' ? box.items : {};
}

async function putOwnerShares(discordId, items) {
  await kvSet(`share:owner:${discordId}`, { items }, SHARE_TTL);
}

// Accounts a user has imported, keyed by puuid:
// { [puuid]: { code, owner_id, owner_name, name, shard, added_at } }
async function getImportedShares(discordId) {
  const box = await kvGet(`share:user:${discordId}`).catch(() => null);
  return box && box.items && typeof box.items === 'object' ? box.items : {};
}

async function putImportedShares(discordId, items) {
  await kvSet(`share:user:${discordId}`, { items }, SHARE_TTL);
}

// ---- Errors -------------------------------------------------------------------
function dbFail(where, error) {
  const err = new Error(`Storage ${where} failed: ${error.message}`);
  err.status = 503;
  throw err;
}

module.exports = {
  isConfigured,
  encrypt,
  decrypt,
  sessionGet,
  sessionSet,
  sessionTouch,
  sessionDestroy,
  sessionDestroyForUser,
  kvSet,
  kvLock,
  kvUnlock,
  kvGet,
  kvExists,
  cleanupExpired,
  kvInsert,
  KV_NO_EXPIRY,
  kvDel,
  kvList,
  getAccount,
  saveAccount,
  deleteAccount,
  listAccounts,
  listAccountsByUser,
  getStats,
  getPrefs,
  setPrefs,
  getWishlist,
  setWishlist,
  hashShareCode,
  SHARE_TTL,
  getShare,
  putShare,
  delShare,
  getOwnerShares,
  putOwnerShares,
  getImportedShares,
  putImportedShares,
};