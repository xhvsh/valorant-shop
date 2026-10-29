'use strict';

const crypto = require('node:crypto');
const https = require('node:https');

const AUTH_BASE = 'https://auth.riotgames.com';
const ENTITLEMENTS_URL = 'https://entitlements.auth.riotgames.com/api/token/v1';
const GEO_URL = 'https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant';
const PD_URLS = {
  storefrontV2: (shard, puuid) => `https://pd.${shard}.a.pvp.net/store/v2/storefront/${puuid}`,
  storefrontV3: (shard, puuid) => `https://pd.${shard}.a.pvp.net/store/v3/storefront/${puuid}`,
  wallet: (shard, puuid) => `https://pd.${shard}.a.pvp.net/store/v1/wallet/${puuid}`,
  mmr: (shard, puuid) => `https://pd.${shard}.a.pvp.net/mmr/v1/players/${puuid}`,
  accountXp: (shard, puuid) => `https://pd.${shard}.a.pvp.net/account-xp/v1/players/${puuid}`,
  entitlements: (shard, puuid) => `https://pd.${shard}.a.pvp.net/store/v1/entitlements/${puuid}`,
  // Unofficial personalization endpoint: the player's currently equipped
  // loadout (identity card/title + spray wheel + primary gun skin).
  loadout: (shard, puuid) => `https://pd.${shard}.a.pvp.net/personalization/v2/players/${puuid}/playerloadout`,
  loadoutLegacy: (shard, puuid) => `https://pd.${shard}.a.pvp.net/personalization/v2/players/${puuid}/loadout`,
};

const CLIENT_PLATFORM = Buffer.from(
  JSON.stringify({
    platformType: 'PC',
    platformOS: 'Windows',
    platformOSVersion: '10.0.19042.1.256.64bit',
    platformChipset: 'Unknown',
  })
).toString('base64');

const SHARDS = ['na', 'eu', 'ap', 'kr', 'pbe'];

// All outbound calls go through here so a hung Riot/API endpoint cannot eat a
// whole serverless invocation (which would time out interactions and crons).
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  // The deadline covers the whole exchange, body included: a response whose
  // headers arrive but whose body then stalls must not hang the request until
  // the serverless function is killed.
  const signal = opts.signal || AbortSignal.timeout(timeoutMs);
  const timedOut = (e) => {
    if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      const err = new Error(`Request timed out (${timeoutMs}ms): ${String(url).split('?')[0]}`);
      err.code = 'TIMEOUT';
      return err;
    }
    return e;
  };
  let res;
  try {
    res = await fetch(url, { ...opts, signal });
  } catch (e) {
    throw timedOut(e);
  }
  for (const m of ['json', 'text', 'arrayBuffer', 'blob']) {
    const read = res[m].bind(res);
    res[m] = () => read().catch((e) => {
      throw timedOut(e);
    });
  }
  return res;
}

function regionToShard(region) {
  const r = String(region || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!r) return null;
  if (r === 'pbe') return 'pbe';
  if (['na', 'us', 'latam', 'br', 'sa'].includes(r)) return 'na';
  if (['eu', 'euw', 'eune'].includes(r)) return 'eu';
  if (['ap', 'oce', 'oc', 'sea'].includes(r)) return 'ap';
  if (['kr'].includes(r)) return 'kr';
  console.warn(`[riot] unknown region "${region}", shard unresolved`);
  return null;
}

function authorizeUrl(clientId, redirectUri, state) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid offline_access',
    state,
  });
  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

const PASTE_AUTH_URL = `${AUTH_BASE}/authorize?${new URLSearchParams({
  redirect_uri: 'http://localhost/redirect',
  client_id: 'riot-client',
  response_type: 'token id_token',
  nonce: '1',
  scope: 'openid link ban lol_region account',
  prompt: 'login',
})}`;

function getPasteAuthUrl() {
  return PASTE_AUTH_URL;
}

function parseRedirectFragment(raw) {
  const text = String(raw || '').trim();
  const fail = (message) => {
    const err = new Error(message);
    err.status = 400;
    throw err;
  };
  if (!text) fail('Paste the redirect URL you copied from your browser address bar.');

  let fragment = '';
  const hash = text.indexOf('#');
  if (hash >= 0) fragment = text.slice(hash + 1);
  else if (/access_token=/.test(text)) fragment = text;
  else if (text.includes('?')) fragment = text.slice(text.indexOf('?') + 1);

  const params = new URLSearchParams(fragment);
  if (params.get('error')) {
    fail(params.get('error_description') || params.get('error'));
  }
  const accessToken = params.get('access_token');
  const code = params.get('code') || null;
  if (!accessToken && !code) {
    fail('No sign-in response found. Copy the whole URL from your address bar.');
  }
  return {
    accessToken,
    code,
    idToken: params.get('id_token') || '',
    expiresIn: Math.max(120, Number(params.get('expires_in') || 3600)),
    refreshToken: params.get('refresh_token') || null,
    state: params.get('state') || '',
    keys: [...params.keys()],
  };
}

// Recovers the link code we put in `nonce` when Riot omits `state` from the
// fragment. The id_token payload is only base64 - we use it purely to correlate
// the callback with the Discord user, never for identity claims.
function nonceFromIdToken(idToken) {
  try {
    const payload = String(idToken).split('.')[1] || '';
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.nonce === 'string' ? json.nonce : '';
  } catch {
    return '';
  }
}

// Authenticated resource call with a DPoP proof (RFC 9449). Some Riot
// endpoints reject these tokens as plain Bearer ("Missing required DPoP
// proof"), so anything that does is routed through here.
async function dpopFetch(url, store, accessToken, { method = 'GET', body } = {}) {
  const key = await getDpopKey(store);
  let nonce = await getDpopNonce(store);
  for (let attempt = 0; attempt <= 1; attempt++) {
    const proof = createDpopProof(key, { method, url, nonce, accessToken });
    const res = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          Authorization: `DPoP ${accessToken}`,
          DPoP: proof,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      15000
    );
    const json = await res.json().catch(() => ({}));
    const headerNonce =
      (res.headers && typeof res.headers.get === 'function' && res.headers.get('dpop-nonce')) || null;
    if (headerNonce) await saveDpopNonce(store, headerNonce);
    if (res.ok) return json;
    if (attempt === 0 && headerNonce && isNonceError(res.status, json)) {
      nonce = headerNonce;
      continue;
    }
    const err = new Error(json.error_description || json.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
}

async function playerSession(store, accessToken, idToken, devKey) {
  const [info, entitlement] = await Promise.all([userinfo(store, accessToken), entitlements(accessToken)]);
  const affinity = await geo(accessToken, idToken);
  const shard = regionToShard(affinity) || regionToShard(info.region) || null;

  const puuid = info.puuid || info.sub || null;
  let name = info.gameName || (info.acct && (info.acct.gameName || info.acct.game_name)) || info.username || null;
  const tag = info.tagLine || (info.acct && (info.acct.tagLine || info.acct.tag_line));
  if (name && tag) name = `${name}#${tag}`;

  if (puuid && (!name || !name.includes('#')) && devKey) {
    const acct = await accountByPuuid(puuid, devKey).catch(() => null);
    if (acct) name = `${acct.gameName}#${acct.tagLine}`;
  }

  return { puuid, name, shard, entitlement };
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) || null;
  } catch {
    return null;
  }
}

// Offline identity from the Riot access/id tokens themselves: the RSO JWT
// carries `sub` (the player PUUID) and the region affinity (`pp.c` / `region`),
// so no userinfo/geo round-trip is needed just to save a linked session.
function playerFromTokens(accessToken, idToken) {
  const payload = decodeJwtPayload(accessToken) || {};
  const alt = decodeJwtPayload(idToken) || {};
  const puuid = payload.sub || alt.sub || null;
  const region =
    (payload.pp && payload.pp.c) || payload.region || payload.affinity || alt.region || alt.affinity || null;
  return { puuid, shard: region ? regionToShard(region) : null };
}

async function tokenRequest(params) {
  const clientId = params.client_id;
  const clientSecret = params.client_secret;
  delete params.client_id;
  delete params.client_secret;

  const body = new URLSearchParams(params);
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetchWithTimeout(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || `Token request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return toTokenSet(json);
}

function toTokenSet(json) {
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    id_token: json.id_token,
    expires_at: Date.now() + (Number(json.expires_in || 3600) - 120) * 1000,
    obtained_at: Date.now(),
  };
}

function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
  });
}

function refreshToken({ clientId, clientSecret, refreshTokenValue }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });
}

async function userinfo(store, accessToken) {
  try {
    return await dpopFetch(`${AUTH_BASE}/userinfo`, store, accessToken, {
      method: 'POST',
      body: {},
    });
  } catch (e) {
    if (e && (e.status === 404 || e.status === 405)) {
      return dpopFetch(`${AUTH_BASE}/userinfo`, store, accessToken, { method: 'GET' });
    }
    throw e;
  }
}

async function entitlements(accessToken) {
  const res = await fetchWithTimeout(ENTITLEMENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ urn: 'urn:entitlement:%' }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `Entitlements request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  const token = json.token || json.entitlements_token;
  if (!token) {
    const err = new Error('Riot returned no entitlement token for this account.');
    err.status = 403;
    throw err;
  }
  return token;
}

async function geo(accessToken, idToken) {
  if (!idToken) return null;
  const res = await fetchWithTimeout(GEO_URL, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ id_token: idToken }),
  });
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const affinity = json && json.affinities && json.affinities.live;
  return affinity || null;
}

async function accountByPuuid(puuid, devKey) {
  if (!puuid || !devKey) return null;
  const res = await fetchWithTimeout(
    `https://americas.api.riotgames.com/riot/account/v1/accounts/by-puuid/${encodeURIComponent(puuid)}`,
    { headers: { 'X-Riot-Token': devKey, Accept: 'application/json' } }
  );
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  if (!json || !json.gameName) return null;
  return json;
}

let versionCache = { value: null, at: 0 };
const VERSION_TTL = 60 * 60 * 1000;

function resetClientVersion() {
  versionCache = { value: null, at: 0 };
}

async function clientVersion() {
  const now = Date.now();
  if (versionCache.value && now - versionCache.at < VERSION_TTL) {
    return versionCache.value;
  }
  try {
    const res = await fetchWithTimeout('https://valorant-api.com/v1/version', { headers: { Accept: 'application/json' } }, 10000);
    const json = await res.json();
    const d = json && json.data;
    let value = d && (d.riotClientVersion || d.riotClientBuild);
    if (!value && d && d.branch && d.buildVersion && d.version) {
      const build = String(d.version).split('.')[3];
      value = `${d.branch}-shipping-${d.buildVersion}-${build || '0'}`;
    }
    if (!value) throw new Error('unexpected version payload');
    versionCache = { value, at: now };
    return value;
  } catch (err) {
    if (versionCache.value) return versionCache.value;
    throw err;
  }
}

async function pdFetch(url, tokens, { method = 'GET', body } = {}) {
  const version = await clientVersion();
  const res = await fetchWithTimeout(url, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'X-Riot-Entitlements-JWT': tokens.entitlement || '',
      'X-Riot-ClientPlatform': CLIENT_PLATFORM,
      'X-Riot-ClientVersion': version,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(
      (json && (json.httpStatus || json.message)) || `Riot store API error (${res.status})`
    );
    err.status = res.status;
    err.riotBody = json;
    throw err;
  }
  return json;
}

async function storefront(shard, puuid, tokens) {
  let primary;
  try {
    primary = await pdFetch(PD_URLS.storefrontV3(shard, puuid), tokens, { method: 'POST', body: {} });
  } catch (err) {
    if (err.status === 404 || err.status === 405 || err.status === 422) {
      return pdFetch(PD_URLS.storefrontV2(shard, puuid), tokens);
    }
    throw err;
  }

  // The v3 response sometimes omits BonusStore (night market) / AccessoryStore
  // even when they are live. The v2 GET response carries them, so fill in
  // whatever section is missing.
  const missing =
    !primary.BonusStore || !primary.AccessoryStore || !primary.SkinsPanelLayout;
  if (missing) {
    try {
      const v2 = await pdFetch(PD_URLS.storefrontV2(shard, puuid), tokens);
      let filled = false;
      if (!primary.BonusStore && v2.BonusStore) { primary.BonusStore = v2.BonusStore; filled = true; }
      if (!primary.AccessoryStore && v2.AccessoryStore) { primary.AccessoryStore = v2.AccessoryStore; filled = true; }
      if (!primary.SkinsPanelLayout && v2.SkinsPanelLayout) { primary.SkinsPanelLayout = v2.SkinsPanelLayout; filled = true; }
      if (!primary.FeaturedBundle && v2.FeaturedBundle) { primary.FeaturedBundle = v2.FeaturedBundle; filled = true; }
      if (filled) console.log('[store] filled missing sections from v2 GET');
    } catch (err) {
      console.warn('[store] v2 supplement failed:', err.status || err.message);
    }
  }
  return primary;
}

function wallet(shard, puuid, tokens) {
  return pdFetch(PD_URLS.wallet(shard, puuid), tokens);
}

// ---- Account details (rank, level, owned items) ------------------------------
// The same unofficial, region-scoped PD endpoints the game client uses. They can
// change without notice, so callers treat failures as optional and show whatever
// did come back.
async function mmr(shard, puuid, tokens) {
  return pdFetch(PD_URLS.mmr(shard, puuid), tokens);
}

async function accountXp(shard, puuid, tokens) {
  return pdFetch(PD_URLS.accountXp(shard, puuid), tokens);
}

async function accountEntitlements(shard, puuid, tokens) {
  return pdFetch(PD_URLS.entitlements(shard, puuid), tokens);
}

// Currently equipped loadout (identity / spray wheel / primary gun). Shape is
// undocumented and can change; callers must treat this as optional data.
async function playerLoadout(shard, puuid, tokens) {
  try {
    return await pdFetch(PD_URLS.loadout(shard, puuid), tokens);
  } catch (err) {
    // The path has moved before; try the older one once before giving up.
    if (err.status === 404 || err.status === 405) return pdFetch(PD_URLS.loadoutLegacy(shard, puuid), tokens);
    throw err;
  }
}

// Marks the night market offers as "seen" in-game. The storefront sometimes
// omits BonusStore until this has been called. Body/shape undocumented -
// failures are harmless and surfaced to callers for diagnostics.
async function revealNightMarket(shard, puuid, tokens) {
  const url = `https://pd.${shard}.a.pvp.net/store/v2/storefront/${puuid}/nightmarket/offers`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'X-Riot-Entitlements-JWT': tokens.entitlement || '',
      'X-Riot-ClientPlatform': CLIENT_PLATFORM,
      'X-Riot-ClientVersion': await clientVersion(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// ===== DPoP + ritoplus PKCE code flow (persistent refresh-token session) =====
// Mirrors the login used by community store apps: client_id=ritoplus with the
// offline_access scope authorizes an authorization_code exchange, and the token
// endpoint demands DPoP proofs (RFC 9449) bound to our P-256 key. Riot binds a
// nonce to the key: we persist it (kv `dpop:nonce`) and echo it in every proof,
// re-challenging once per request when it has lapsed.

const DPOP_CLIENT_ID = 'ritoplus';
const DPOP_SCOPE =
  'lol summoner offline_access openid link ban account riot://riot.authenticator/session.auth';
const DPOP_PRM = 'alias:change game:play riot:interact chat:text chat:voice friend:add';
const DPOP_UA =
  'RiotGamesApi/26.3.0.0 rso-auth (Android;15.00;AP4A.250105.002;) ritoplus/5.3.0';
const DPOP_REDIRECT_URI = 'http://localhost/redirect';

function base64url(input) {
  return Buffer.from(input).toString('base64url').replace(/=+$/, '');
}

function createDpopKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  return { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y, d: priv.d };
}

function createDpopProof(key, { method, url, nonce, accessToken }) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  const payload = {
    jti: crypto.randomUUID(),
    htm: String(method).toUpperCase(),
    htu: parsed.toString(),
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  if (accessToken) {
    payload.ath = base64url(crypto.createHash('sha256').update(accessToken).digest());
  }
  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: { kty: key.kty, crv: key.crv, x: key.x, y: key.y },
  };
  const enc = (obj) => base64url(Buffer.from(JSON.stringify(obj), 'utf8'));
  const signingKey = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: key.x, y: key.y, d: key.d },
    format: 'jwk',
  });
  const input = `${enc(header)}.${enc(payload)}`;
  const sig = crypto.sign('sha256', input, {
    key: signingKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${base64url(sig)}`;
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// The DPoP key never changes and the nonce changes rarely, but both used to be read
// from (and the key re-written to) the database on every Riot call. They are kept per
// instance now. The nonce is only written when Riot hands out a new one. Riot answers
// a stale nonce with a fresh one and the call is retried, so a slightly old copy costs
// nothing.
const DPOP_NONCE_TTL = 365 * 24 * 60 * 60 * 1000;
const DPOP_NONCE_MEMO_MS = 60 * 1000;
let dpopKeyMemo = null; // the key object
let dpopNonceMemo = null; // { nonce, at }

// The signing key is stored encrypted (iv:tag:data) like the account tokens, and it
// never expires: every refresh token is bound to it. A row holding a plain JWK is the
// old format; it is used as is and re-saved encrypted (same key, so tokens stay valid).
// Read and decrypt failures throw on purpose: falling back to a new key would orphan
// every linked account.
async function readStoredDpopKey(store) {
  const raw = await store.kvGet('dpop:key');
  if (!raw) return null;
  if (typeof raw === 'string') return { key: store.decrypt(raw), legacy: false };
  if (raw && typeof raw === 'object' && raw.d) return { key: raw, legacy: true };
  throw new Error('DPoP key row is unreadable.');
}

async function getDpopKey(store) {
  if (dpopKeyMemo) return dpopKeyMemo;
  const stored = await readStoredDpopKey(store);
  if (stored) {
    if (stored.legacy) {
      try {
        const sealed = store.encrypt(stored.key);
        const back = store.decrypt(sealed);
        if (back.d === stored.key.d && back.x === stored.key.x && back.y === stored.key.y) {
          await store.kvSet('dpop:key', sealed, store.KV_NO_EXPIRY);
        }
      } catch (e) {
        console.warn(`[dpop] could not re-save the key encrypted: ${(e && e.message) || e}`);
      }
    }
    dpopKeyMemo = stored.key;
    return stored.key;
  }
  // Create only if the row is truly absent (insert, never upsert). If another instance
  // won the race, use the key it stored.
  const key = createDpopKey();
  if (!(await store.kvInsert('dpop:key', store.encrypt(key), store.KV_NO_EXPIRY))) {
    const winner = await readStoredDpopKey(store);
    if (!winner) throw new Error('DPoP key could not be loaded.');
    dpopKeyMemo = winner.key;
    return winner.key;
  }
  dpopKeyMemo = key;
  return key;
}

async function getDpopNonce(store) {
  if (dpopNonceMemo && Date.now() - dpopNonceMemo.at < DPOP_NONCE_MEMO_MS) return dpopNonceMemo.nonce;
  const box = await store.kvGet('dpop:nonce').catch(() => null);
  const nonce = (box && box.nonce) || null;
  dpopNonceMemo = { nonce, at: Date.now() };
  return nonce;
}

async function saveDpopNonce(store, nonce) {
  if (!nonce) return;
  if (dpopNonceMemo && dpopNonceMemo.nonce === nonce) {
    dpopNonceMemo.at = Date.now();
    return;
  }
  dpopNonceMemo = { nonce, at: Date.now() };
  await store.kvSet('dpop:nonce', { nonce }, DPOP_NONCE_TTL).catch(() => {});
}

// Riot answers a missing/stale DPoP nonce with a 400 naming the nonce plus a
// fresh one in the DPoP-Nonce header. Only that case is worth one retry;
// anything else (bad grant, bad proof) would just fail twice.
function isNonceError(status, json) {
  if (status !== 400 && status !== 401) return false;
  const s = `${(json && json.error) || ''} ${(json && json.error_description) || ''}`.toLowerCase();
  return s.includes('nonce');
}

async function dpopTokenRequest(key, store, form) {
  const body = new URLSearchParams(form).toString();
  let nonce = await getDpopNonce(store);
  for (let attempt = 0; attempt <= 1; attempt++) {
    const proof = createDpopProof(key, {
      method: 'POST',
      url: `${AUTH_BASE}/token`,
      nonce,
    });
    const { status, json, headers } = await httpsPost(
      `${AUTH_BASE}/token`,
      { DPoP: proof, Accept: 'application/json' },
      body
    );
    const headerNonce = headers['dpop-nonce'] || headers['DPoP-Nonce'] || null;
    if (headerNonce) await saveDpopNonce(store, headerNonce);
    if (status >= 200 && status < 300) {
      console.log(`[dpop] attempt ${attempt} -> ${status} ok`);
      return toTokenSet(json);
    }
    console.log(`[dpop] attempt ${attempt} -> ${status} ${json.error_description || json.error || ''}`.slice(0, 160));
    if (attempt === 0 && headerNonce && isNonceError(status, json)) {
      nonce = headerNonce;
      continue;
    }
    {
      const err = new Error(
        json.error_description || json.error || `Riot token request failed (${status})`
      );
      err.status = status;
      throw err;
    }
  }
  const err = new Error('Riot DPoP nonce loop exhausted.');
  err.status = 400;
  throw err;
}

function httpsPost(url, extraHeaders, body, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // `timeout` below only fires on an idle socket; this caps the whole request.
    const hard = setTimeout(() => req.destroy(new Error('Riot token request timed out')), timeoutMs);
    const req = https.request(
      u,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': DPOP_UA,
          ...extraHeaders,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(hard);
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Riot token request timed out')));
    req.on('error', (e) => {
      clearTimeout(hard);
      reject(e);
    });
    req.write(body);
    req.end();
  });
}

async function exchangeDpopCode(store, code, pkceVerifier) {
  const key = await getDpopKey(store);
  return dpopTokenRequest(key, store, {
    client_id: DPOP_CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: DPOP_REDIRECT_URI,
    code_verifier: pkceVerifier,
    riot_prm: DPOP_PRM,
  });
}

async function refreshDpop(store, refreshTokenValue) {
  const key = await getDpopKey(store);
  return dpopTokenRequest(key, store, {
    client_id: DPOP_CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshTokenValue,
  });
}

module.exports = {
  SHARDS,
  regionToShard,
  fetchWithTimeout,
  resetClientVersion,
  authorizeUrl,
  getPasteAuthUrl,
  parseRedirectFragment,
  nonceFromIdToken,
  playerSession,
  decodeJwtPayload,
  playerFromTokens,
  exchangeCode,
  refreshToken,
  userinfo,
  entitlements,
  dpopFetch,
  geo,
  accountByPuuid,
  storefront,
  wallet,
  mmr,
  accountXp,
  accountEntitlements,
  playerLoadout,
  revealNightMarket,
  clientVersion,
  CLIENT_PLATFORM,
  createDpopKey,
  createDpopProof,
  generatePkce,
  getDpopKey,
  exchangeDpopCode,
  refreshDpop,
  DPOP_CLIENT_ID,
  DPOP_SCOPE,
  DPOP_REDIRECT_URI,
};
