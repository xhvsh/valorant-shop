'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

// Load .env before any src/ module: storage reads SUPABASE_* at require time,
// so loading it later silently left local runs on the in-memory fallback.
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch {
  /* no .env file yet (Vercel injects env vars instead) */
}

const riot = require('./src/riot');
const items = require('./src/items');
const storage = require('./src/storage');
const shop = require('./src/shop');
const PackageStore = require('./src/session');
const { verifyRequest } = require('./src/discord/verify');
const { buildNotice, EPHEMERAL, buildShopMessage, buildAccessoryMessage, buildNightMarketMessage, buildBundleMessage, bundleAccentColor, buildRankMessage, buildCollectionMessage, collectionColumns, bundleComponents, dailyFooter, alertFooter } = require('./src/discord/embeds');
const { handleInteraction, bundlePayload, prewarmBundles, BUNDLE_SOURCE_ID, accountChoices, OWN_ACCOUNT_COMMANDS } = require('./src/discord/commands');
const { dedupeBundles } = require('./src/parse');
const dcLog = require('./src/discord/log');
const { waitUntil } = require('@vercel/functions');
const { renderSkinGrid, renderAnimatedSkinGrid, renderWalletImage, renderBundleGrid, renderBundleMedia, renderRankImage, renderCollectionImage } = require('./src/grid');

// fetch with a hard deadline. Without one, a stalled Discord (or self) call holds
// the request until the serverless function is killed at 60s.
function dfetch(url, init = {}, ms = 15000) {
  return fetch(url, { ...init, signal: init.signal || AbortSignal.timeout(ms) });
}

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = String(process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const APP_URL = String(process.env.APP_URL || BASE_URL).replace(/\/+$/, '');
// Optional subpath mount (e.g. "/valorant-shop"). Empty means root. When set,
// the whole app is reachable both at root (vercel.app) and under the prefix
// (xhv.sh/valorant-shop) so existing links keep working.
const BASE_PATH = String(process.env.BASE_PATH || '').replace(/\/+$/, '').replace(/^(?!\/)/, '');
const DEV_API_KEY = process.env.RIOT_DEV_API_KEY || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const LINK_SECRET = process.env.LINK_SECRET || '';
const SCHEDULER_SECRET = process.env.SCHEDULER_SECRET || '';
if (!SESSION_SECRET || !LINK_SECRET) {
  throw new Error('Missing SESSION_SECRET / LINK_SECRET. Set both env vars (refusing to boot with ephemeral secrets).');
}
const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY || '';
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';

const app = express();
app.set('trust proxy', 1);

// The public home for this app is xhv.sh/valorant-shop. Direct browser hits on
// the *.vercel.app hostname are bounced there so the real domain is the only
// one people see. Machine traffic that legitimately uses the vercel.app host
// must be left alone: the main-page proxy forwards requests under the mount
// prefix, Vercel crons invoke /api/cron/*, and /health is a probe.
const CANONICAL_HOME = String(process.env.CANONICAL_HOME || 'https://xhv.sh/valorant-shop').replace(/\/+$/, '');
const SELF_HOST_ALLOWLIST = ['/api/cron', '/api/interactions', '/health'];
app.use((req, res, next) => {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  if (!host.endsWith('.vercel.app')) return next();
  const pathOnly = req.url.split('?')[0];
  if (BASE_PATH && (pathOnly === BASE_PATH || pathOnly.startsWith(`${BASE_PATH}/`))) return next();
  if (SELF_HOST_ALLOWLIST.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`))) return next();
  const target = (BASE_PATH && pathOnly !== '/') ? `${CANONICAL_HOME}${pathOnly}` : CANONICAL_HOME;
  res.redirect(307, target);
});

// Subpath mount. A request to `${BASE_PATH}/...` (e.g. /valorant-shop/api/shop)
// is rewritten in-place to `/...` so every route, static handler and header
// below works unchanged under the prefix. Requests that do not start with the
// prefix are left alone, so the app stays reachable at root too. The mount
// point actually used for this request is stashed on the response so HTML
// rendering can emit the matching <base href>.
if (BASE_PATH) {
  const prefix = BASE_PATH;
  app.use((req, res, next) => {
    const q = req.url.indexOf('?');
    const pathOnly = q === -1 ? req.url : req.url.slice(0, q);
    const query = q === -1 ? '' : req.url.slice(q);
    if (pathOnly === prefix) {
      req.url = `/${query}`;
      res.locals.mountPath = prefix;
      req.mountPath = prefix;
    } else if (pathOnly.startsWith(`${prefix}/`)) {
      req.url = pathOnly.slice(prefix.length) + query;
      res.locals.mountPath = prefix;
      req.mountPath = prefix;
    } else {
      res.locals.mountPath = '';
      req.mountPath = '';
    }
    next();
  });
} else {
  app.use((req, res, next) => {
    res.locals.mountPath = '';
    req.mountPath = '';
    next();
  });
}

app.use(
  session({
    name: 'valshops.sid',
    secret: SESSION_SECRET,
    store: new PackageStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: BASE_URL.startsWith('https'),
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

// ---- Security headers -------------------------------------------------------
// Applied to every response. The dashboard ships no inline scripts and no on*
// handlers, so script-src stays strict. style-src allows 'unsafe-inline' because
// the markup uses inline style attributes (per-card CSS custom properties).
// Images come from our own origin plus the Valorant item CDN and Discord avatars.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://media.valorant-api.com https://cdn.discordapp.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  next();
});

// Website (dashboard) is disabled when WEBSITE_ENABLED=false; only the Discord
// bot surface stays reachable: interactions, follow-up, cron, /link + auth.
const WEBSITE_ENABLED = ['1', 'true', 'yes'].includes(
  String(process.env.WEBSITE_ENABLED === undefined ? 'true' : process.env.WEBSITE_ENABLED).toLowerCase()
);
const BOT_PATHS = [
  '/link',
  '/api/interactions',
  '/api/cron/refresh',
  '/api/cron/dailyshop',
  '/api/cron/bundles',
  '/api/skin-grid',
  '/api/bundle-grid',
  '/health',
];
app.use((req, res, next) => {
  if (WEBSITE_ENABLED) return next();
  const allowed = BOT_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`));
  if (allowed) return next();
  if (req.path === '/') {
    return res
      .type('text/plain')
      .send('valorant shop Discord bot is running. The website is coming later.');
  }
  const err = new Error('Not found.');
  err.status = 404;
  next(err);
});

// The Discord interactions endpoint must see the exact raw request bytes to
// verify the Ed25519 signature, so skip the JSON parser for just that path.
const globalJson = express.json({ limit: '1mb' });
app.use((req, res, next) => {
  if (req.path === '/api/interactions') return next();
  globalJson(req, res, next);
});

// Dashboard UI lives in website/ (excluded from Vercel's static output). The
// gate above decides what is reachable, so static registration order after it
// is intentional.
// index.html must never be served stale or a client can keep an old page that
// points at old asset versions - and its ETag/Last-Modified are unreliable
// across deploys (same byte size => same tag), so we use no-store rather than
// no-cache. Assets carry a ?v= tag, so a short shared cache is enough and lets
// even a change made without bumping ?v pick up within the hour.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'website', 'index.html'), 'utf8');
// When a request arrives under a mount prefix, absolute links in the markup
// (/styles.css, /fonts/*, /dashboard.js, /auth/discord) must be rewritten to
// that prefix so the browser does not escape the subpath, and a matching
// <base href> is injected so dashboard.js can prefix its own API calls. At
// root (vercel.app) the HTML is served untouched.
function renderIndexHtml(mountPath) {
  if (!mountPath) return INDEX_HTML;
  return INDEX_HTML
    .replace(/(href|src)="\//g, `$1="${mountPath}/`)
    .replace(/<head>/i, `<head>\n  <base href="${mountPath}/" />`);
}
// Dashboard routes are real paths (history API), so each one returns the shell.
app.get(['/', '/index.html', '/wishlist', '/bundles', '/settings', '/a/:puuid', '/a/:puuid/:tab'], (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.type('html').send(renderIndexHtml(res.locals.mountPath || ''));
});
// Disclaimer page. Its asset links are relative, so it works at / and under the mount.
app.get('/legal', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  res.sendFile(path.join(__dirname, 'website', 'legal.html'));
});
app.use(express.static(path.join(__dirname, 'website'), {
  setHeaders(res, filePath) {
    if (/[\\/]index\.html$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store, must-revalidate');
    else if (/[\\/]fonts[\\/]/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=604800');
    else res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
  },
}));

const rateLog = new Map();
// Best-effort per instance only (serverless runs many instances); pruned so the map cannot grow forever.
function rateLimit(key, limit = 5, windowMs = 60000) {
  const now = Date.now();
  if (rateLog.size > 2000) {
    for (const k of [...rateLog.keys()].slice(0, 500)) rateLog.delete(k);
  }
  const hits = (rateLog.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const err = new Error('Too many attempts. Wait a minute and try again.');
    err.status = 429;
    throw err;
  }
  hits.push(now);
  rateLog.set(key, hits);
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---- Discord login (website) ---------------------------------------------------
// The dashboard identifies users by Discord OAuth. Sessions stay in our own
// session store; no Supabase Auth involved.
// Public origin as the browser sees it. Behind the xhv.sh rewrite the upstream
// host is valorant-shop.vercel.app, so trust the proxy's forwarded host/proto
// when present (Vercel sets both) to keep the OAuth callback on xhv.sh.
function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.get('host') || '').split(',')[0].trim();
  return `${proto}://${host}`;
}
function oauthRedirectUri(req) {
  return `${publicOrigin(req)}${req.mountPath || ''}/auth/discord/callback`;
}

app.get('/auth/discord', (req, res) => {
  const state = crypto.randomBytes(18).toString('hex');
  req.session.discordOauthState = state;
  const url =
    'https://discord.com/oauth2/authorize?' +
    new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      redirect_uri: oauthRedirectUri(req),
      response_type: 'code',
      scope: 'identify',
      state,
    });
  req.session.save(() => res.redirect(url));
});

app.get('/auth/discord/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!code || !state || state !== req.session.discordOauthState) {
      throw httpError('Invalid login response. Try again.', 400);
    }
    delete req.session.discordOauthState;
    const tokenRes = await dfetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: oauthRedirectUri(req),
      }),
    });
    if (!tokenRes.ok) throw httpError('Discord login failed. Try again.', 400);
    const tok = await tokenRes.json();
    const meRes = await dfetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!meRes.ok) throw httpError('Discord login failed. Try again.', 400);
    const me = await meRes.json();
    req.session.discordId = me.id;
    req.session.discordName = me.username;
    req.session.discordAvatar = me.avatar;
    await new Promise((resolve) => req.session.save(resolve));
    res.redirect(`${req.mountPath || ''}/`);
  } catch (err) {
    console.warn(`[discord-login] failed: ${(err && err.message) || err}`);
    next(err);
  }
});

function requireDiscord(req, res, next) {
  if (req.session && req.session.discordId) return next();
  const err = new Error('Sign in with Discord first.');
  err.status = 401;
  next(err);
}

// ---- Dashboard API (Discord session) -----------------------------------------

app.get('/api/me', async (req, res) => {
  if (!req.session.discordId) return res.json({ ok: true, authorized: false });
  res.json({
    ok: true,
    authorized: true,
    discordId: req.session.discordId,
    username: req.session.discordName || null,
    avatar: req.session.discordAvatar || null,
  });
});

// Public install links so users can add the bot without a session:
// user install ("Add App", works in DMs) and classic server install.
app.get('/api/install', async (req, res) => {
  const base = 'https://discord.com/oauth2/authorize';
  const userInstall =
    `${base}?` +
    new URLSearchParams({ client_id: DISCORD_CLIENT_ID, integration_type: '1', scope: 'applications.commands' });
  const guildInstall =
    `${base}?` +
    new URLSearchParams({
      client_id: DISCORD_CLIENT_ID,
      integration_type: '0',
      scope: 'bot applications.commands',
      permissions: '0',
    });
  res.json({ ok: true, userInstall, guildInstall });
});

// Website heartbeat: tells an open tab which version is live now, so it can
// offer to update in place. The version comes straight from the ?v= tag on
// dashboard.js in index.html, so there is one source of truth to bump.
// Public (no session) and never 500s - if we cannot read it, the client just
// tries again on its next tick.
let versionCache = { at: 0, version: '' };
function websiteVersion() {
  const now = Date.now();
  if (versionCache.version && now - versionCache.at < 30000) return versionCache.version;
  try {
    const html = fs.readFileSync(path.join(__dirname, 'website', 'index.html'), 'utf8');
    const found = html.match(/dashboard\.js\?v=(\d+)/);
    if (found && found[1]) {
      versionCache = { at: now, version: found[1] };
      return versionCache.version;
    }
  } catch {
    /* unreadable/bundling oddity: fall through to the last known value */
  }
  return versionCache.version;
}

app.get('/api/version', (req, res, next) => {
  try {
    // Cheap per-instance guard against hammering a public endpoint.
    if (req.ip) rateLimit(`version:${req.ip}`, 120, 60000);
  } catch (err) {
    return next(err);
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, version: websiteVersion() });
});

// Public aggregate counts for the footer strip. Cached in memory for 10 minutes
// (and for 5 minutes at the edge) so the accounts table is not scanned on every
// page load. Returns only two integers, never per-user data, and never surfaces
// storage errors to the client (the widget just stays hidden).
let statsCache = { at: 0, data: null };
app.get('/api/stats', async (req, res, next) => {
  try {
    // Public endpoint: throttle per IP. The value is cached anyway, so a modest
    // cap is enough to stop abuse without affecting normal page loads.
    if (req.ip) rateLimit(`stats:${req.ip}`, 60, 60000);
  } catch (err) {
    return next(err);
  }
  try {
    const now = Date.now();
    if (!statsCache.data || now - statsCache.at > 10 * 60 * 1000) {
      const data = await storage.getStats();
      statsCache = { at: now, data };
    }
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ ok: true, users: statsCache.data.users, accounts: statsCache.data.accounts });
  } catch (err) {
    console.error('[stats]', err.message);
    res.set('Cache-Control', 'no-store');
    res.json({ ok: false });
  }
});

app.get('/api/accounts', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const [accounts, prefs] = await Promise.all([
      storage.listAccountsByUser(discordId),
      storage.getPrefs(discordId),
    ]);
    // Main account pinned first, then the rest in creation order.
    accounts.sort((a, b) => {
      const byMain = Number(b.is_default) - Number(a.is_default);
      if (byMain) return byMain;
      return a.created_at - b.created_at;
    });
    const rows = await Promise.all(
      accounts.map(async (a) => {
        const cached = await shop.cachedStoreFor(discordId, a.puuid, a).catch(() => null);
        const wallet = cached && cached.status === 'ok' && cached.store ? cached.store.wallet : null;
        return {
          puuid: a.puuid,
          name: a.name,
          label: a.label,
          shard: a.shard,
          is_default: a.is_default,
          linked: Boolean(a.auth_encrypted),
          wallet,
          alerts: (prefs.accounts && prefs.accounts[a.puuid]) || { shop: false, accessory: false, wishlist_shop: false, wishlist_accessory: false },
        };
      })
    );
    const shared = await importedSharesFor(discordId);
    const sharedRows = await Promise.all(
      shared.map(async (s) => {
        const ownerAcct = await storage.getAccount(s.owner_id, s.puuid).catch(() => null);
        const cached = await shop.cachedStoreFor(s.owner_id, s.puuid, ownerAcct).catch(() => null);
        const wallet = cached && cached.status === 'ok' && cached.store ? cached.store.wallet : null;
        return {
          puuid: s.puuid,
          name: (ownerAcct && ownerAcct.name) || s.name,
          label: (ownerAcct && ownerAcct.label) || s.name,
          shard: (ownerAcct && ownerAcct.shard) || s.shard,
          shared: true,
          sharedBy: { id: s.owner_id, name: s.owner_name || null },
          linked: Boolean(ownerAcct && ownerAcct.auth_encrypted),
          wallet,
        };
      })
    );
    // Combined display order over every account (own and shared, main included)
    // exactly as the user arranged them. Rebuilt from the saved order; accounts
    // missing from it (new links/imports) are appended, main first.
    const all = [
      ...accounts.map((a) => String(a.puuid)),
      ...sharedRows.map((s) => String(s.puuid)),
    ];
    const allSet = new Set(all);
    const savedOrder = Array.isArray(prefs.order) ? prefs.order.map(String) : [];
    const combinedOrder = [...new Set(savedOrder.filter((p) => allSet.has(p)))];
    // Orders saved before main could be moved never contain it: keep it first.
    const main = accounts.find((a) => a.is_default);
    if (main && !combinedOrder.includes(String(main.puuid))) combinedOrder.unshift(String(main.puuid));
    for (const p of all) if (!combinedOrder.includes(p)) combinedOrder.push(p);
    res.json({
      ok: true,
      accounts: rows,
      shared: sharedRows,
      order: combinedOrder,
      nm: prefs.nm === true,
      bundle: prefs.bundle === true,
      wishlist_nm: prefs.wishlist_nm === true,
      nm_names: prefs.nm_names === true,
    });
  } catch (err) {
    next(err);
  }
});

// Make one of the user's own accounts the main (default) one. Shared by the
// dashboard and the /main command. Returns the account row.
async function setMainAccount(discordId, puuid) {
  if (!puuid) throw httpError('Missing account.', 400);
  const target = await storage.getAccount(discordId, puuid);
  if (!target) throw httpError('Unknown account.', 404);
  const accounts = await storage.listAccountsByUser(discordId);
  for (const a of accounts) {
    if (a.is_default && a.puuid !== puuid) {
      await storage.saveAccount(discordId, a.puuid, { is_default: false });
    }
  }
  await storage.saveAccount(discordId, puuid, { is_default: true });
  return target;
}

app.post('/api/accounts/default', express.json(), requireDiscord, async (req, res, next) => {
  try {
    await setMainAccount(req.session.discordId, String((req.body && req.body.puuid) || ''));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/accounts/:puuid', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const puuid = String(req.params.puuid || '');
    const target = await storage.getAccount(discordId, puuid);
    if (!target) throw httpError('Unknown account.', 404);
    const ownerItems = await storage.getOwnerShares(discordId);
    if (ownerItems[puuid] && ownerItems[puuid].code) {
      const digest = storage.hashShareCode(ownerItems[puuid].code);
      const rec = await storage.getShare(digest).catch(() => null);
      if (rec && rec.owner_id === discordId) await dropShare(discordId, rec, digest);
    }
    await storage.deleteAccount(discordId, puuid);
    await storage.kvDel(`shop_reset:${discordId}:${puuid}`).catch(() => {});
    const rest = await storage.listAccountsByUser(discordId);
    if (!rest.length) {
      await storage.kvDel(`alertprefs:${discordId}`).catch(() => {});
      await storage.kvDel(`dailyshop:${discordId}`).catch(() => {});
      await storage.kvDel(`shop_reset:${discordId}`).catch(() => {});
    } else if (target.is_default) {
      await storage.saveAccount(discordId, rest[0].puuid, { is_default: true });
    }
    dcLog.sendLog(`${dcLog.userMention(discordId)} removed account **${target.label || target.name || target.puuid}** (${target.shard || '?'})`);
    res.json({ ok: true, remaining: rest.length });
  } catch (err) {
    next(err);
  }
});

// Account details (rank, level, owned skins) for the dashboard detail modal.
// Backed by unofficial Riot PD endpoints, so it is throttled per user and
// degrades gracefully: a required re-link or a failed optional call never 500s.
app.get('/api/accounts/:puuid/details', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    rateLimit(`${discordId}:details`, 30, 60000);
    const puuid = String(req.params.puuid || '');
    // Details are read from whichever account holds the Riot session: the
    // caller's own account, or the owner's when the puuid was shared with them.
    const access = await accountAccessFor(discordId, puuid);
    if (!access) throw httpError('Unknown account.', 404);
    const result = await shop.accountDetails(access.ownerId, puuid);
    if (result.status === 'unlinked') throw httpError('Unknown account.', 404);
    if (result.status === 'relink') return res.json({ ok: true, status: 'relink' });
    if (result.status === 'error') {
      return res.json({ ok: false, status: 'error', error: result.error || 'Could not load account details.' });
    }
    res.json({ ok: true, status: 'ok', cached: Boolean(result.cached), details: result.details });
  } catch (err) {
    next(err);
  }
});

// Persist the dashboard's drag order for the user's own accounts. Purely
// cosmetic, stored in kv (no schema change); unknown puuids are dropped and any
// account missing from the payload is appended so the list stays complete.
app.get('/api/prefs', requireDiscord, async (req, res, next) => {
  try {
    res.json({ ok: true, prefs: await storage.getPrefs(req.session.discordId) });
  } catch (err) {
    next(err);
  }
});

app.put('/api/prefs', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const body = req.body || {};
    const accounts = await storage.listAccountsByUser(discordId);
    const owned = new Set(accounts.map((a) => String(a.puuid)));
    const clean = {};
    const incoming = body.accounts && typeof body.accounts === 'object' ? body.accounts : {};
    for (const [puuid, v] of Object.entries(incoming)) {
      if (!owned.has(String(puuid))) continue;
      clean[String(puuid)] = {
        shop: Boolean(v && v.shop),
        accessory: Boolean(v && v.accessory),
        wishlist_shop: Boolean(v && v.wishlist_shop),
        wishlist_accessory: Boolean(v && v.wishlist_accessory),
      };
    }
    const prefs = {
      accounts: clean,
      nm: body.nm === true,
      bundle: body.bundle === true,
      wishlist_nm: body.wishlist_nm === true,
      nm_names: body.nm_names === true,
      order: cleanOrder(body.order),
    };
    await storage.setPrefs(discordId, prefs);
    res.json({ ok: true, prefs });
  } catch (err) {
    next(err);
  }
});

function cleanOrder(order) {
  if (!Array.isArray(order)) return [];
  return [...new Set(order.map((p) => String(p || '')).filter((p) => p && p.length <= 100))].slice(0, 100);
}

// Partial prefs update: only the fields sent are changed, so toggling one
// alert or saving a new account order never overwrites the rest. Accepts
// { accounts: { <puuid>: { shop?, accessory?, wishlist_shop?, wishlist_accessory? } }, nm?, bundle?, wishlist_nm?, nm_names?, order? }.
const ALERT_KINDS = ['shop', 'accessory', 'wishlist_shop', 'wishlist_accessory'];
app.patch('/api/prefs', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const body = req.body || {};
    const prefs = await storage.getPrefs(discordId);
    const next_ = {
      accounts: { ...(prefs.accounts || {}) },
      nm: prefs.nm === true,
      bundle: prefs.bundle === true,
      wishlist_nm: prefs.wishlist_nm === true,
      nm_names: prefs.nm_names === true,
      order: cleanOrder(prefs.order),
    };
    if (body.accounts && typeof body.accounts === 'object') {
      const owned = new Set((await storage.listAccountsByUser(discordId)).map((a) => String(a.puuid)));
      for (const [puuid, v] of Object.entries(body.accounts)) {
        if (!owned.has(String(puuid)) || !v || typeof v !== 'object') continue;
        const cur = { shop: false, accessory: false, wishlist_shop: false, wishlist_accessory: false, ...(next_.accounts[puuid] || {}) };
        for (const k of ALERT_KINDS) if (typeof v[k] === 'boolean') cur[k] = v[k];
        next_.accounts[String(puuid)] = cur;
      }
    }
    if (typeof body.nm === 'boolean') next_.nm = body.nm;
    if (typeof body.bundle === 'boolean') next_.bundle = body.bundle;
    if (typeof body.wishlist_nm === 'boolean') next_.wishlist_nm = body.wishlist_nm;
    if (typeof body.nm_names === 'boolean') next_.nm_names = body.nm_names;
    if (Array.isArray(body.order)) next_.order = cleanOrder(body.order);
    await storage.setPrefs(discordId, next_);
    res.json({ ok: true, prefs: next_ });
  } catch (err) {
    next(err);
  }
});

// ---- Account sharing --------------------------------------------------------
// Owners mint a short code for one of their linked accounts; anyone with the
// code imports that account as a read-only "shared" card. Recipients never
// receive the owner's Riot tokens - shared shops are read from the owner's own
// stored session. Codes are 8 chars over a 32-symbol alphabet (~40 bits) and
// only stored as an HMAC digest, so a DB dump does not leak usable codes.

const SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no I/O/0/1
const SHARE_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

function newShareCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += SHARE_ALPHABET[bytes[i] & 31];
  return out;
}

function normalizeShareCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Cross-instance limiter (kv-backed) so code guessing is throttled even across
// serverless instances, where an in-memory counter would be per-instance only.
async function rateLimitShared(scope, limit, windowMs) {
  const key = `rl:${scope}`;
  const now = Date.now();
  const prev = await storage.kvGet(key).catch(() => null);
  const hits = (Array.isArray(prev) ? prev : []).filter((t) => now - Number(t) < windowMs);
  if (hits.length >= limit) {
    const err = new Error('Too many attempts. Wait a bit and try again.');
    err.status = 429;
    throw err;
  }
  hits.push(now);
  await storage.kvSet(key, hits, windowMs + 1000).catch(() => {});
}

// A user's imported shares, validated against the live code records. Anything
// whose code was revoked - or whose grant was removed by the owner - is quietly
// dropped from the user's list on read.
async function importedSharesFor(discordId) {
  const items = await storage.getImportedShares(discordId);
  const out = [];
  let dirty = false;
  for (const [puuid, item] of Object.entries(items)) {
    const rec = item && item.code ? await storage.getShare(storage.hashShareCode(item.code)).catch(() => null) : null;
    if (!rec || rec.puuid !== puuid || !rec.recipients || !rec.recipients[discordId]) {
      delete items[puuid];
      dirty = true;
      continue;
    }
    out.push({
      puuid,
      code: rec.code,
      owner_id: rec.owner_id,
      owner_name: rec.owner_name || item.owner_name || null,
      name: rec.name || item.name,
      shard: rec.shard || item.shard,
    });
  }
  if (dirty) await storage.putImportedShares(discordId, items).catch(() => {});
  return out;
}

// Resolves a puuid the caller is allowed to use: their own account, or one
// shared to them. Returns { ownerId, shared, ownerName } where ownerId is the
// Discord id whose stored Riot session serves the shop, or null when the puuid
// is neither owned nor shared.
async function accountAccessFor(discordId, puuid) {
  if (!puuid) return { ownerId: discordId, shared: false };
  const own = await storage.getAccount(discordId, puuid).catch(() => null);
  if (own) return { ownerId: discordId, shared: false };
  const shared = await importedSharesFor(discordId).catch(() => []);
  const s = shared.find((x) => String(x.puuid) === String(puuid));
  if (s) return { ownerId: s.owner_id, shared: true, ownerName: s.owner_name || null };
  return null;
}

// getShop for a puuid that may belong to another user via a share. Shared shops
// are read from the owner's own stored session; their tokens never reach the
// recipient. The result is flagged with `shared` for tailored messaging.
async function shopFor(discordId, puuid) {
  const access = await accountAccessFor(discordId, puuid);
  if (!access) return { status: 'unlinked', shared: true };
  const result = await shop.getShop(access.ownerId, puuid);
  if (access.shared) return { ...result, shared: true, ownerName: access.ownerName };
  return result;
}

// Fully removes a share code: detaches every recipient and forgets it on the
// owner's side.
async function dropShare(ownerId, rec, digest) {
  for (const granteeId of Object.keys(rec.recipients || {})) {
    const theirItems = await storage.getImportedShares(granteeId).catch(() => ({}));
    if (theirItems[rec.puuid] && theirItems[rec.puuid].code === rec.code) {
      delete theirItems[rec.puuid];
      await storage.putImportedShares(granteeId, theirItems).catch(() => {});
    }
  }
  await storage.delShare(digest);
  await storage.kvDel(`share:puuid:${rec.puuid}`).catch(() => {});
  const ownerItems = await storage.getOwnerShares(ownerId).catch(() => ({}));
  if (ownerItems[rec.puuid] && ownerItems[rec.puuid].code === rec.code) {
    delete ownerItems[rec.puuid];
    await storage.putOwnerShares(ownerId, ownerItems).catch(() => {});
  }
}

// ---- Share helpers (shared by the dashboard routes and the /share command) ----

// Create (or return the existing) share code for one of the user's accounts.
// Returns { code, existing, name, recipients }.
async function createShareFor(discordId, ownerName, puuid) {
  await rateLimitShared(`share-create:${discordId}`, 20, 60000);
  const acct = await storage.getAccount(discordId, puuid);
  if (!acct) throw httpError('Unknown account.', 404);
  if (!acct.auth_encrypted) throw httpError('Only linked accounts can be shared.', 400);

  const ownerItems = await storage.getOwnerShares(discordId);
  const existing = ownerItems[puuid];
  if (existing && existing.code) {
    const rec = await storage.getShare(storage.hashShareCode(existing.code)).catch(() => null);
    if (rec && rec.owner_id === discordId) {
      return { code: existing.code, existing: true, name: rec.name, recipients: Object.keys(rec.recipients || {}).length };
    }
  }

  // One code per Riot account across all users: the same account can be linked
  // by more than one Discord user, but only the first to share it holds a code.
  const holder = await shareHolderFor(puuid);
  if (holder && holder !== discordId) throw httpError('This Riot account is already shared by someone else.', 409);

  const code = newShareCode();
  const digest = storage.hashShareCode(code);
  const name = acct.label || acct.name || puuid;
  await storage.kvSet(`share:puuid:${puuid}`, { owner_id: discordId }, 3650 * 24 * 60 * 60 * 1000);
  await storage.putShare(digest, {
    code,
    owner_id: discordId,
    owner_name: ownerName || null,
    puuid,
    name,
    shard: acct.shard || null,
    created_at: Date.now(),
    recipients: {},
  });
  ownerItems[puuid] = { code, name, shard: acct.shard || null, created_at: Date.now() };
  await storage.putOwnerShares(discordId, ownerItems);
  dcLog.sendLog(`${dcLog.userMention(discordId)} created a share code for **${name}**`);
  return { code, existing: false, name, recipients: 0 };
}

// Discord id that currently holds the share code for a puuid, or null. Uses the
// puuid index; records from before the index existed are found by a one-off
// scan (only on code creation, which is rare and rate limited).
async function shareHolderFor(puuid) {
  const idx = await storage.kvGet(`share:puuid:${puuid}`).catch(() => null);
  if (idx && idx.owner_id) {
    const items = await storage.getOwnerShares(idx.owner_id).catch(() => ({}));
    if (items[puuid] && items[puuid].code) return idx.owner_id;
  }
  const rows = (await storage.kvList('share:code:').catch(() => [])) || [];
  for (const r of rows) {
    const v = r && (r.value || r);
    if (v && v.puuid === puuid && v.owner_id) return v.owner_id;
  }
  return null;
}

// Import a shared account by code for `discordId`. `ip` is optional (website).
async function importShareFor(discordId, username, rawCode, ip) {
  await rateLimitShared(`share-import:${discordId}`, 6, 60000);
  if (ip) await rateLimitShared(`share-import-ip:${ip}`, 20, 60000);
  const code = normalizeShareCode(rawCode);
  if (!SHARE_CODE_RE.test(code)) throw httpError('That code does not look right.', 400);
  const digest = storage.hashShareCode(code);
  const rec = await storage.getShare(digest).catch(() => null);
  if (!rec) throw httpError('Invalid or expired code.', 404);
  if (rec.owner_id === discordId) throw httpError('You cannot import your own shared account.', 400);
  const owned = await storage.getAccount(discordId, rec.puuid);
  if (owned) throw httpError('You already have this account in your list.', 400);
  const items = await storage.getImportedShares(discordId);
  if (items[rec.puuid]) throw httpError('You already imported this shared account.', 400);
  rec.recipients = rec.recipients || {};
  rec.recipients[discordId] = { name: username || null, added_at: Date.now() };
  await storage.putShare(digest, rec);
  items[rec.puuid] = {
    code: rec.code,
    owner_id: rec.owner_id,
    owner_name: rec.owner_name || null,
    name: rec.name,
    shard: rec.shard,
    added_at: Date.now(),
  };
  await storage.putImportedShares(discordId, items);
  dcLog.sendLog(`${dcLog.userMention(discordId)} imported a shared account **${rec.name}** from ${dcLog.userMention(rec.owner_id)}`);
  return { puuid: rec.puuid, name: rec.name, shard: rec.shard, ownerName: rec.owner_name || null };
}

// Stop sharing one of the owner's accounts (by puuid). Returns the account
// name, or null when the account was not shared.
async function revokeShareFor(discordId, puuid) {
  await rateLimitShared(`share-revoke:${discordId}`, 30, 60000);
  const ownerItems = await storage.getOwnerShares(discordId);
  const entry = ownerItems[puuid];
  if (!entry || !entry.code) return null;
  const digest = storage.hashShareCode(entry.code);
  const rec = await storage.getShare(digest).catch(() => null);
  if (!rec || rec.owner_id !== discordId) {
    delete ownerItems[puuid];
    await storage.putOwnerShares(discordId, ownerItems).catch(() => {});
    return null;
  }
  await dropShare(discordId, rec, digest);
  dcLog.sendLog(`${dcLog.userMention(discordId)} revoked the share code for **${rec.name}**`);
  return rec.name || puuid;
}

// Full data wipe for one Discord user: every linked Riot account and its stored
// tokens, alert settings, wishlist, share codes they own (recipients lose access
// at once), shares they imported, markers, and every website session. Returns a
// summary of what was removed.
const WIPE_MARKER_PREFIXES = ['shop_reset:', 'dailyshop_sent:', 'accshop_sent:', 'wishlist_notify:'];
async function wipeUserData(discordId) {
  const summary = { accounts: 0, sharesRevoked: 0, recipientsRemoved: 0, importsRemoved: 0 };

  const accounts = await storage.listAccountsByUser(discordId);
  summary.accounts = accounts.length;

  // Shares the user owns: drop each code, which also detaches every recipient.
  const ownerItems = await storage.getOwnerShares(discordId).catch(() => ({}));
  for (const entry of Object.values(ownerItems)) {
    if (!entry || !entry.code) continue;
    const digest = storage.hashShareCode(entry.code);
    const rec = await storage.getShare(digest).catch(() => null);
    if (rec && rec.owner_id === discordId) {
      summary.recipientsRemoved += Object.keys(rec.recipients || {}).length;
      await dropShare(discordId, rec, digest);
      summary.sharesRevoked += 1;
    }
  }

  // Shares the user imported: take them off the owner's recipient list.
  const imported = await storage.getImportedShares(discordId).catch(() => ({}));
  for (const item of Object.values(imported)) {
    if (!item || !item.code) continue;
    const digest = storage.hashShareCode(item.code);
    const rec = await storage.getShare(digest).catch(() => null);
    if (rec && rec.recipients && rec.recipients[discordId]) {
      delete rec.recipients[discordId];
      await storage.putShare(digest, rec).catch(() => {});
    }
    summary.importsRemoved += 1;
  }

  await storage.deleteAccount(discordId);

  const keys = [
    `alertprefs:${discordId}`,
    `wishlist:${discordId}`,
    `dailyshop:${discordId}`,
    `nm_announced:${discordId}`,
    `share:owner:${discordId}`,
    `share:user:${discordId}`,
    `shop_reset:${discordId}`,
  ];
  for (const a of accounts) keys.push(`share:puuid:${a.puuid}`);
  for (const prefix of WIPE_MARKER_PREFIXES) {
    const rows = await storage.kvList(`${prefix}${discordId}:`).catch(() => []);
    for (const row of rows) if (row.key.startsWith(`${prefix}${discordId}:`)) keys.push(row.key);
  }
  for (const key of keys) await storage.kvDel(key).catch(() => {});

  await storage.sessionDestroyForUser(discordId).catch(() => {});
  return summary;
}

// Delete everything stored about the signed-in user. The client sends the typed
// confirmation; the session ends with the response.
app.post('/api/me/delete', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    if (!req.body || req.body.confirm !== 'DELETE') throw httpError('Type DELETE to confirm.', 400);
    await rateLimitShared(`wipe:${discordId}`, 3, 60000);
    const summary = await wipeUserData(discordId);
    dcLog.sendLog(`${dcLog.userMention(discordId)} deleted all their data (${summary.accounts} account(s), ${summary.sharesRevoked} share(s) revoked, ${summary.recipientsRemoved} recipient(s) lost access)`);
    req.session.destroy(() => {
      res.clearCookie('valshops.sid', { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https') });
      res.json({ ok: true, summary });
    });
  } catch (err) {
    next(err);
  }
});

// Create (or return the existing) share code for one of the user's accounts.
app.post('/api/shares', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const puuid = String((req.body && req.body.puuid) || '');
    const out = await createShareFor(req.session.discordId, req.session.discordName, puuid);
    res.json({ ok: true, code: out.code, existing: out.existing || undefined });
  } catch (err) {
    next(err);
  }
});

// The user's own share codes + who has imported each.
app.get('/api/shares', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const ownerItems = await storage.getOwnerShares(discordId);
    const shares = [];
    let dirty = false;
    for (const [puuid, entry] of Object.entries(ownerItems)) {
      const rec = entry && entry.code ? await storage.getShare(storage.hashShareCode(entry.code)).catch(() => null) : null;
      if (!rec || rec.owner_id !== discordId) {
        delete ownerItems[puuid];
        dirty = true;
        continue;
      }
      const recipients = Object.entries(rec.recipients || {}).map(([id, v]) => ({
        id,
        name: (v && v.name) || null,
        added_at: (v && v.added_at) || 0,
      }));
      shares.push({ puuid, code: rec.code, name: rec.name, shard: rec.shard, created_at: rec.created_at, rotated_at: entry.rotated_at || rec.rotated_at || null, recipients });
    }
    if (dirty) await storage.putOwnerShares(discordId, ownerItems).catch(() => {});
    res.json({ ok: true, shares });
  } catch (err) {
    next(err);
  }
});

// Revoke a whole code (removes it for every recipient too).
app.delete('/api/shares/:code', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    await rateLimitShared(`share-revoke:${discordId}`, 30, 60000);
    const code = normalizeShareCode(req.params.code);
    if (!SHARE_CODE_RE.test(code)) throw httpError('Unknown share code.', 404);
    const digest = storage.hashShareCode(code);
    const rec = await storage.getShare(digest).catch(() => null);
    if (!rec || rec.owner_id !== discordId) throw httpError('Unknown share code.', 404);
    await dropShare(discordId, rec, digest);
    dcLog.sendLog(`${dcLog.userMention(discordId)} revoked the share code for **${rec.name}**`);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Remove a single recipient from a code (the code keeps working for others).
app.delete('/api/shares/:code/recipients/:granteeId', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    await rateLimitShared(`share-revoke:${discordId}`, 30, 60000);
    const code = normalizeShareCode(req.params.code);
    const granteeId = String(req.params.granteeId || '');
    if (!SHARE_CODE_RE.test(code)) throw httpError('Unknown share code.', 404);
    const digest = storage.hashShareCode(code);
    const rec = await storage.getShare(digest).catch(() => null);
    if (!rec || rec.owner_id !== discordId) throw httpError('Unknown share code.', 404);
    if (rec.recipients && rec.recipients[granteeId]) {
      delete rec.recipients[granteeId];
      await storage.putShare(digest, rec);
      const theirItems = await storage.getImportedShares(granteeId).catch(() => ({}));
      if (theirItems[rec.puuid] && theirItems[rec.puuid].code === rec.code) {
        delete theirItems[rec.puuid];
        await storage.putImportedShares(granteeId, theirItems).catch(() => {});
      }
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Rotate a share code to a brand-new one without disturbing access. People who
// already imported it keep working (their stored code is silently updated);
// anyone you removed gets nothing, because the old code stops resolving - so a
// removed user can't re-list the account using a code you already handed out.
// Cooldown per account so it can't be spammed.
const SHARE_ROTATE_COOLDOWN_MS = 60 * 1000;

app.post('/api/shares/:puuid/rotate', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const puuid = String(req.params.puuid || '');
    if (!puuid) throw httpError('Missing account.', 400);

    const ownerItems = await storage.getOwnerShares(discordId);
    const entry = ownerItems[puuid];
    if (!entry || !entry.code) throw httpError('This account is not shared.', 404);

    const oldCode = entry.code;
    const oldDigest = storage.hashShareCode(oldCode);
    const rec = await storage.getShare(oldDigest).catch(() => null);
    if (!rec || rec.owner_id !== discordId) throw httpError('This share no longer exists.', 404);

    const now = Date.now();
    if (entry.rotated_at && now - entry.rotated_at < SHARE_ROTATE_COOLDOWN_MS) {
      const wait = Math.ceil((SHARE_ROTATE_COOLDOWN_MS - (now - entry.rotated_at)) / 1000);
      return res.status(429).json({
        error: `You can refresh this code again in ${wait}s.`,
        retry_after: wait,
      });
    }

    // Mint a code that isn't already in use.
    const newCode = newShareCode();
    const newDigest = storage.hashShareCode(newCode);
    if (await storage.getShare(newDigest).catch(() => null)) {
      throw httpError('Could not generate a new code. Try again in a moment.', 500);
    }

    // Re-point the share record at the new code, keeping every recipient intact.
    await storage.putShare(newDigest, { ...rec, code: newCode, rotated_at: now });
    await storage.delShare(oldDigest);

    // Owner's own pointer.
    ownerItems[puuid] = { ...entry, code: newCode, rotated_at: now };
    await storage.putOwnerShares(discordId, ownerItems);

    // Silently update the stored code for everyone who already imported it.
    const keepers = Object.keys(rec.recipients || {});
    for (const granteeId of keepers) {
      const theirItems = await storage.getImportedShares(granteeId).catch(() => null);
      if (theirItems && theirItems[puuid] && theirItems[puuid].code === oldCode) {
        theirItems[puuid] = { ...theirItems[puuid], code: newCode };
        await storage.putImportedShares(granteeId, theirItems).catch(() => {});
      }
    }

    dcLog.sendLog(`${dcLog.userMention(discordId)} refreshed the share code for **${rec.name}** (${keepers.length} kept)`);
    res.json({ ok: true, code: newCode, rotated_at: now, cooldown_ms: SHARE_ROTATE_COOLDOWN_MS, recipients: keepers.length });
  } catch (err) {
    next(err);
  }
});

// Import a shared account by code.
app.post('/api/shares/import', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const out = await importShareFor(req.session.discordId, req.session.discordName, req.body && req.body.code, req.ip);
    res.json({ ok: true, account: { puuid: out.puuid, name: out.name, shard: out.shard } });
  } catch (err) {
    next(err);
  }
});

// A recipient removes a shared account from their own list (owner keeps theirs).
app.delete('/api/shares/imported/:puuid', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const puuid = String(req.params.puuid || '');
    const items = await storage.getImportedShares(discordId);
    const item = items[puuid];
    if (!item) throw httpError('Unknown shared account.', 404);
    delete items[puuid];
    await storage.putImportedShares(discordId, items);
    const digest = storage.hashShareCode(item.code);
    const rec = await storage.getShare(digest).catch(() => null);
    if (rec && rec.recipients && rec.recipients[discordId]) {
      delete rec.recipients[discordId];
      await storage.putShare(digest, rec).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---- Wishlist (per Discord user, dashboard only) ------------------------------

const wlLocks = new Map();
function withWishlistLock(discordId, fn) {
  const key = String(discordId);
  const prev = wlLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  wlLocks.set(
    key,
    run.then(
      () => {},
      () => {}
    )
  );
  return run;
}

function resolveWishItem(item) {
  const live = items.resolve(item.id);
  const type = live.type !== 'unknown' ? live.type : item.type;
  return {
    id: item.id,
    type,
    name: live.name !== 'Unknown Item' ? live.name : item.name,
    icon: live.icon || item.icon || null,
    art: live.art || item.art || null,
    kind: item.kind,
    addedAt: item.addedAt,
    live: live.type !== 'unknown',
  };
}

app.get('/api/wishlist', requireDiscord, async (req, res, next) => {
  try {
    await items.load().catch(() => {});
    const wl = await storage.getWishlist(req.session.discordId);
    res.json({
      ok: true,
      daily: wl.daily.map(resolveWishItem),
      accessory: wl.accessory.map(resolveWishItem),
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/wishlist', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const id = String((req.body && req.body.id) || '');
    if (!id) throw httpError('Missing item id.', 400);
    await items.load().catch(() => {});
    const resolved = items.resolve(id);
    const kind = items.kindOf(resolved.type);
    if (!kind) throw httpError('That item cannot be wishlisted.', 400);
    if (!items.isStoreEligibleId(resolved.id)) throw httpError('That item cannot appear in your shop.', 400);
    const nameKey = items.normalizeName(resolved.name);
    const item = await withWishlistLock(req.session.discordId, async () => {
      const wl = await storage.getWishlist(req.session.discordId);
      const strip = (list) => list.filter((x) => String(x.id) !== id && items.normalizeName(x.name) !== nameKey);
      wl.daily = strip(wl.daily);
      wl.accessory = strip(wl.accessory);
      const entry = {
        id: resolved.id || id,
        name: resolved.name,
        type: resolved.type,
        icon: resolved.icon,
        art: resolved.art || null,
        kind,
        addedAt: Date.now(),
      };
      wl[kind].push(entry);
      await storage.setWishlist(req.session.discordId, wl);
      return entry;
    });
    res.json({ ok: true, item: resolveWishItem(item) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/wishlist/:id', requireDiscord, async (req, res, next) => {
  try {
    const id = String(req.params.id || '');
    if (!id) throw httpError('Missing item id.', 400);
    const nameKey = items.normalizeName((items.resolve(id).name) || '');
    await withWishlistLock(req.session.discordId, async () => {
      const wl = await storage.getWishlist(req.session.discordId);
      const strip = (list) =>
        list.filter((x) => String(x.id) !== id && !(nameKey && items.normalizeName(x.name) === nameKey));
      wl.daily = strip(wl.daily);
      wl.accessory = strip(wl.accessory);
      await storage.setWishlist(req.session.discordId, wl);
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Apply many add/remove ops (in order) under one lock. Used by the dashboard so
// a burst of changes - or a page refresh mid-change - never loses updates. The
// idempotent per-item semantics make re-sends after a keepalive/beacon safe.
app.post('/api/wishlist/batch', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body && req.body.ops) ? req.body.ops : null;
    if (!raw) throw httpError('Missing wishlist ops.', 400);
    if (raw.length > 500) throw httpError('Too many wishlist changes at once.', 400);
    await items.load().catch(() => {});
    const result = await withWishlistLock(req.session.discordId, async () => {
      const wl = await storage.getWishlist(req.session.discordId);
      for (const entry of raw) {
        const id = String((entry && entry.id) || '');
        if (!id) continue;
        const op = entry.op === 'remove' ? 'remove' : 'add';
        const resolved = items.resolve(id);
        const kind = items.kindOf(resolved.type);
        if (!kind) continue;
        const nameKey = items.normalizeName(resolved.name);
        const strip = (list) =>
          list.filter((x) => String(x.id) !== id && !(nameKey && items.normalizeName(x.name) === nameKey));
        wl.daily = strip(wl.daily);
        wl.accessory = strip(wl.accessory);
        if (op === 'add') {
          if (!items.isStoreEligibleId(resolved.id || id)) continue;
          wl[kind].push({
            id: resolved.id || id,
            name: resolved.name,
            type: resolved.type,
            icon: resolved.icon,
            art: resolved.art || null,
            kind,
            addedAt: Date.now(),
          });
        }
      }
      await storage.setWishlist(req.session.discordId, wl);
      return wl;
    });
    res.json({
      ok: true,
      daily: result.daily.map(resolveWishItem),
      accessory: result.accessory.map(resolveWishItem),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/items/search', requireDiscord, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').slice(0, 60);
    const kind = String(req.query.kind || '');
    const results = await items.search(q, kind);
    res.json({ ok: true, results });
  } catch (err) {
    next(err);
  }
});

// Full compact catalog for client-side wishlist search (instant, uncapped).
app.get('/api/items/index', requireDiscord, async (req, res, next) => {
  try {
    await items.load().catch(() => {});
    res.set('Cache-Control', 'private, max-age=60');
    res.json({ ok: true, items: items.storeIndex() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/item', requireDiscord, async (req, res, next) => {
  try {
    const id = String(req.query.id || '').slice(0, 80);
    if (!id) throw httpError('Missing item id.', 400);
    await items.load().catch(() => {});
    res.json({ ok: true, item: await items.details(id) });
  } catch (err) {
    next(err);
  }
});

// ---- Live shop viewer (own accounts only) -------------------------------------

app.get('/api/shop', requireDiscord, async (req, res, next) => {
  try {
    const discordId = req.session.discordId;
    const puuid = String(req.query.puuid || '') || undefined;
    if (puuid && !(await storage.getAccount(discordId, puuid))) {
      // Not one of the user's own accounts - is it a shared one? Serve it from
      // the owner's own stored session; the owner's tokens never reach here.
      const items = await storage.getImportedShares(discordId);
      const item = items[puuid];
      if (!item) throw Object.assign(new Error('That account is not in your list.'), { status: 404 });
      const rec = await storage.getShare(storage.hashShareCode(item.code)).catch(() => null);
      if (!rec || rec.puuid !== puuid || !(rec.recipients && rec.recipients[discordId])) {
        delete items[puuid];
        await storage.putImportedShares(discordId, items).catch(() => {});
        throw Object.assign(new Error('This shared account is no longer available.'), { status: 404 });
      }
      const result = await shop.getShop(rec.owner_id, puuid);
      if (result.status !== 'ok') {
        const msg =
          result.status === 'relink' || result.status === 'unlinked'
            ? 'The owner needs to re-link this account.'
            : `Could not load the shop (${result.error || 'unknown error'}).`;
        throw Object.assign(new Error(msg), { status: result.status === 'error' ? 502 : 400 });
      }
      const a = result.account;
      const store = result.store;
      return res.json({
        ok: true,
        cached: Boolean(result.cached),
        shared: true,
        account: { puuid: a.puuid, name: a.name, label: a.label, shard: a.shard },
        store,
      });
    }
    const result = await shop.getShop(discordId, puuid);
    if (result.status !== 'ok') {
      const err = new Error(
        result.status === 'unlinked' || result.status === 'relink'
          ? 'That account is not linked anymore.'
          : `Could not load the shop (${result.error || 'unknown error'}).`
      );
      err.status = result.status === 'error' ? 502 : 400;
      throw err;
    }
    const a = result.account;
    const store = result.store;
    res.json({
      ok: true,
      cached: Boolean(result.cached),
      account: { puuid: a.puuid, name: a.name, label: a.label, shard: a.shard, is_default: a.is_default },
      store,
    });
  } catch (err) {
    next(err);
  }
});

// ---- Featured bundles viewer --------------------------------------------------
// Always pulls from the shared source account (same as /bundle) so every visitor
// sees the same rotation without needing their own linked account.

app.get('/api/bundles', requireDiscord, async (req, res, next) => {
  try {
    let result = await shop.getShop(BUNDLE_SOURCE_ID, undefined, { owned: false });
    if (result.status === 'ok' && (!result.store.bundles || !result.store.bundles.length)) {
      result = await shop.getShop(BUNDLE_SOURCE_ID, undefined, { force: true, owned: false }).catch(() => result);
    }
    let raw = result.status === 'ok' ? result.store.bundles || [] : [];
    if (!raw.length) {
      const src = await storage.getAccount(BUNDLE_SOURCE_ID).catch(() => null);
      raw = (src && src.store_cache && src.store_cache.bundles) || [];
    }
    if (raw.length) {
      shop.rememberBundles(raw).catch(() => {});
    } else {
      // Live source unavailable: fall back to any account's cached bundles, then
      // to the last good global snapshot, so bundle data survives a relink.
      raw = await shop.anyCachedBundles().catch(() => []);
    }
    await items.load().catch(() => {});
    const bundles = dedupeBundles(raw).map((b) => ({
      id: b.id,
      name: b.name,
      art: b.art,
      before: b.before,
      after: b.after,
      percent: b.percent,
      leavesAt: b.leavesAt,
      items: (b.items || []).map((it) => {
        const r = items.resolve(it.id);
        return {
          id: it.id,
          name: r.name,
          type: r.type,
          icon: r.icon,
          art: r.art || null,
          tier: r.tier,
          base: it.base,
          disc: it.disc,
          percent: it.percent,
        };
      }),
    }));
    res.json({ ok: true, cached: Boolean(result.cached), bundles });
  } catch (err) {
    next(err);
  }
});

app.post('/auth/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('valshops.sid', { httpOnly: true, sameSite: 'lax', secure: BASE_URL.startsWith('https') });
    res.json({ ok: true });
  });
});

// ---- Add a Riot account from the dashboard -------------------------------------
// Same DPoP code flow as the old link page, but bound to the Discord session
// instead of a link code.

app.post('/api/accounts/add/start', express.json(), requireDiscord, async (req, res, next) => {
  try {
    rateLimit(`${req.session.discordId}:add`, 6, 60000);
    const flowId = crypto.randomBytes(9).toString('hex');
    const { verifier, challenge } = riot.generatePkce();
    await storage.kvSet(`pkce:add:${flowId}`, { verifier, discordId: req.session.discordId }, 15 * 60 * 1000);
    const url =
      'https://auth.riotgames.com/authorize?' +
      new URLSearchParams({
        client_id: 'ritoplus',
        redirect_uri: 'http://localhost/redirect',
        response_type: 'code',
        scope: 'lol summoner offline_access openid link ban account riot://riot.authenticator/session.auth',
        state: flowId,
        nonce: flowId,
        prompt: 'login',
        code_challenge: challenge,
        code_challenge_method: 'S256',
      });
    res.json({ ok: true, flowId, url });
  } catch (err) {
    next(err);
  }
});

app.post('/api/accounts/add/complete', express.json(), requireDiscord, async (req, res, next) => {
  try {
    const flowId = String((req.body && req.body.flowId) || '');
    const raw = String((req.body && req.body.url) || '');
    if (!flowId || !raw) throw httpError('Missing sign-in data.', 400);
    const flow = await storage.kvGet(`pkce:add:${flowId}`).catch(() => null);
    if (!flow || flow.discordId !== req.session.discordId) {
      throw httpError('This add-account attempt expired. Start again.', 400);
    }
    const parsed = riot.parseRedirectFragment(raw);
    if (!parsed.code) {
      throw httpError('The pasted URL has no sign-in code. Copy the FULL address bar URL and paste it again.', 400);
    }
    try {
      const tokens = await riot.exchangeDpopCode(storage, parsed.code, flow.verifier || '');
      await storage.kvDel(`pkce:add:${flowId}`).catch(() => {});
      let displayName = null;
      try {
        const ps = await riot.playerSession(storage, tokens.access_token, tokens.id_token, DEV_API_KEY);
        displayName = (ps && ps.name) || null;
      } catch {
        displayName = null;
      }
      const result = await linkAccount(req.session.discordId, tokens, null, { displayName });
      if (result.puuid) {
        await shop.getShop(req.session.discordId, result.puuid, { owned: false }).catch(() => null);
      }
      dcLog.sendLog(`${dcLog.userMention(req.session.discordId)} linked account **${result.name}**`);
      res.json({ ...result, hasRefreshToken: Boolean(tokens.refresh_token) });
    } catch (e) {
      await storage.kvDel(`pkce:add:${flowId}`).catch(() => {});
      if (e && e.status && e.status < 500) throw e;
      if (/invalid_grant/i.test(e.message || '')) {
        throw httpError('That sign-in code expired or came from a different page. Start again and paste the URL right away.', 400);
      }
      throw httpError(`Riot sign-in could not be completed (${e.message}).`, 400);
    }
  } catch (err) {
    const sid = req.session && req.session.discordId ? req.session.discordId : '?';
    if (err.status && err.status < 500) {
      dcLog.sendLog(`Link failed for ${dcLog.userMention(sid)}: ${err.message}`);
      return res.status(err.status).json({ ok: false, error: err.message });
    }
    dcLog.sendLog(`${dcLog.adminMention()} link error for ${dcLog.userMention(sid)}: ${(err && err.message) || err}`, { ping: true });
    next(err);
  }
});

// ---- Riot account linking (dashboard add-account flow) -----------------------

async function linkAccount(discordId, tokens, cookies, opts = {}) {
  if (!tokens || !tokens.access_token) {
    throw httpError('Riot login did not return a token. Try again.', 400);
  }

  // Identity always comes from the fresh tokens, never from an existing row:
  // signing in with a different Riot account links it as an additional row
  // instead of merging into (or overwriting) the existing one.
  const local = riot.playerFromTokens(tokens.access_token, tokens.id_token);
  let puuid = local.puuid;
  let shard = local.shard;
  let freshName = (opts && opts.displayName) || null;
  if (!puuid || !shard) {
    const player = await riot.playerSession(storage, tokens.access_token, tokens.id_token, DEV_API_KEY);
    if (!player.puuid) throw httpError('Riot login did not return a player.', 400);
    if (!player.shard) throw httpError('Could not determine your region. Try signing in again.', 400);
    puuid = player.puuid;
    shard = player.shard;
    freshName = player.name || null;
  }

  // A Riot account can be linked by more than one Discord user: each user gets
  // their own row (keyed by discord_id + puuid) with their own tokens. Look up
  // only this user's existing row so a repeat link refreshes it in place.
  const previous = await storage.getAccount(discordId, puuid).catch(() => null);

  let prevAuth = null;
  if (previous && previous.auth_encrypted) {
    try {
      prevAuth = storage.decrypt(previous.auth_encrypted);
    } catch {
      prevAuth = null;
    }
  }
  const auth = {
    cookies: cookies || (prevAuth && prevAuth.cookies) || null,
    refresh_token: tokens.refresh_token || (prevAuth && prevAuth.refresh_token) || null,
    access_token: tokens.access_token,
    id_token: tokens.id_token,
    expires_at: tokens.expires_at,
  };

  const mine = previous ? [previous] : await storage.listAccountsByUser(discordId).catch(() => []);
  const name = freshName || (previous && previous.name) || puuid;
  await storage.saveAccount(discordId, puuid, {
    name,
    label: (previous && previous.label) || name,
    shard,
    is_default: previous ? previous.is_default : mine.length === 0,
    auth_encrypted: storage.encrypt(auth),
  });
  return { ok: true, name, puuid };
}

app.get('/link', (req, res) => res.redirect(`${req.mountPath || ''}/`));

// ---- Discord interactions ----------------------------------------------------

function discordIdFrom(body) {
  return (((body.member && body.member.user) || body.user || {}).id) || null;
}

async function fireFollowUp(payload) {
  await dfetch(`${APP_URL}/api/interactions/followup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-link-secret': LINK_SECRET },
    body: JSON.stringify(payload),
  }, 50000);
}

// Renders the shop/accessory grid + wallet as attachments and builds the CV2
// message that references them. Shared by the /shop reply and the daily DM.
async function renderShopMessage(result, isAcc, opts = {}) {
  const name = result.account && result.account.name;
  const ks = result.store && result.store.kingdomShop;
  const ksItems = (ks && ks.items) || [];
  let gridName = isAcc ? 'accessory-grid.gif' : 'shop-grid.png';
  let gridBuf;
  // The wallet image renders alongside the grid, not after it.
  const walletPromise = renderWalletImage(result.store.wallet);
  walletPromise.catch(() => {});
  if (isAcc) {
    // Sprays animate, so try the animated GIF grid first and fall back to PNG.
    gridBuf = await renderAnimatedSkinGrid(result.store, {
      items: ksItems,
      limit: 8,
      wishlist: opts.wishlist,
    }).catch(() => null);
    if (!gridBuf) {
      gridBuf = await renderSkinGrid(result.store, { items: ksItems, limit: 8, showType: true, wishlist: opts.wishlist });
      gridName = 'accessory-grid.png';
    }
  } else {
    gridBuf = await renderSkinGrid(result.store, { wishlist: opts.wishlist });
  }
  const walletName = 'wallet.png';
  const walletPng = await walletPromise;
  const files = [];
  if (gridBuf) files.push({ name: gridName, buf: gridBuf });
  if (walletPng) files.push({ name: walletName, buf: walletPng });
  const payload = isAcc
    ? buildAccessoryMessage(
        result.store,
        name,
        gridBuf ? `attachment://${gridName}` : null,
        walletPng ? `attachment://${walletName}` : null
      )
    : buildShopMessage(
        result.store,
        name,
        gridBuf ? `attachment://${gridName}` : null,
        walletPng ? `attachment://${walletName}` : null,
        opts
      );
  return { payload, files };
}

// Builds the automated daily DM. Daily shop and accessory shop are independent
// embeds: whichever is due is rendered, and when both are due they're sent as
// separate embeds in one message. The footer is added once, to the bottom embed.
async function renderDailyDm(result, opts = {}) {
  const name = result.account && result.account.name;
  const store = result.store || {};
  const components = [];
  const files = [];
  const walletPng = await renderWalletImage(store.wallet);
  const walletUrl = walletPng ? 'attachment://wallet.png' : null;
  if (walletPng) files.push({ name: 'wallet.png', buf: walletPng });

  if (opts.shop) {
    const gridPng = await renderSkinGrid(store, { wishlist: opts.wishlist });
    const gridUrl = gridPng ? 'attachment://shop-grid.png' : null;
    if (gridPng) files.push({ name: 'shop-grid.png', buf: gridPng });
    const built = buildShopMessage(store, name, gridUrl, walletUrl, { daily: true, footer: false });
    components.push(...built.components);
  }
  if (opts.accessory) {
    const ks = store.kingdomShop;
    if (ks && ks.items && ks.items.length) {
      let accName = 'accessory-grid.gif';
      let accBuf = await renderAnimatedSkinGrid(store, {
        items: ks.items,
        limit: 8,
        wishlist: opts.wishlist,
      }).catch(() => null);
      if (!accBuf) {
        accBuf = await renderSkinGrid(store, { items: ks.items, limit: 8, showType: true, wishlist: opts.wishlist });
        accName = 'accessory-grid.png';
      }
      const accUrl = accBuf ? `attachment://${accName}` : null;
      if (accBuf) files.push({ name: accName, buf: accBuf });
      const built = buildAccessoryMessage(store, name, accUrl, walletUrl);
      components.push(...built.components);
    }
  }
  if (!components.length) return { payload: null, files: [] };
  const last = components[components.length - 1];
  if (last && Array.isArray(last.components)) last.components.push(dailyFooter(opts.manageUrl));
  return { payload: { flags: 1 << 15, components }, files };
}

// Opens (or reuses) a DM channel with the user and posts the given message.
async function sendDirectMessage(discordId, payload, files) {
  const botToken = process.env.DISCORD_BOT_TOKEN || '';
  if (!botToken) throw new Error('no bot token configured');
  const channelRes = await dfetch('https://discord.com/api/v10/users/@me/channels', {
    method: 'POST',
    headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: discordId }),
  });
  if (!channelRes.ok) {
    const err = new Error(`dm channel ${channelRes.status}`);
    err.status = channelRes.status;
    throw err;
  }
  const channel = await channelRes.json();
  const body = { ...payload };
  delete body.files;
  let init;
  if (files && files.length) {
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify(body));
    files.forEach((f, i) =>
      fd.append(`files[${i}]`, new Blob([f.buf], { type: /\.gif$/i.test(f.name) ? 'image/gif' : 'image/png' }), f.name)
    );
    init = { method: 'POST', headers: { Authorization: `Bot ${botToken}` }, body: fd };
  } else {
    init = {
      method: 'POST',
      headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
  }
  const msgRes = await dfetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, init);
  if (!msgRes.ok) {
    const err = new Error(`dm send ${msgRes.status} ${await msgRes.text().catch(() => '')}`);
    err.status = msgRes.status;
    throw err;
  }
  return channel.id;
}

// Slash command options, flattened through one subcommand level:
// /share import code:X -> { sub: 'import', options: [{ name: 'code', ... }] }.
function commandOptions(data) {
  const top = (data && data.options) || [];
  const subOpt = top.find((o) => o && (o.type === 1 || o.type === 2));
  if (subOpt) return { sub: subOpt.name, options: subOpt.options || [] };
  return { sub: null, options: top };
}

const interactionCtx = {
  storage,
  shop,
  embeds: { buildShopMessage, buildAccessoryMessage, buildNightMarketMessage, buildBundleMessage, bundleAccentColor, buildRankMessage, buildCollectionMessage, bundleComponents },
  linkBaseUrl: APP_URL,
  fireFollowUp,
};

app.post(
  '/api/interactions',
  express.raw({ type: '*/*' }),
  async (req, res, next) => {
    try {
      const signature = req.headers['x-signature-ed25519'];
      const timestamp = req.headers['x-signature-timestamp'];
      if (!DISCORD_PUBLIC_KEY) {
        return res.status(503).json({ error: 'bot is not configured' });
      }
      if (!verifyRequest(DISCORD_PUBLIC_KEY, signature, timestamp, req.body)) {
        return res.status(401).json({ error: 'invalid request signature' });
      }

      const body = JSON.parse(req.body.toString('utf8'));
      if (body.type === 1) return res.json({ type: 1 });

      if (body.type === 4) {
        const data = body.data || {};
        const { options } = commandOptions(data);
        const focused = options.find((o) => o && o.focused);
        const query = focused && focused.value != null ? String(focused.value) : '';
        const choices = await accountChoices(interactionCtx, discordIdFrom(body), query, {
          ownOnly: OWN_ACCOUNT_COMMANDS.has(data.name),
        }).catch(() => []);
        return res.json({ type: 8, data: { choices } });
      }

      if (body.type === 2) {
        const response = await handleInteraction(body, interactionCtx);
        const iname = (body.data && body.data.name) || '';
        if (response.type === 5) {
          console.log(`[int] defer sent name=${iname} id=${body.id}`);
          const { sub, options: cmdOpts } = commandOptions(body.data || {});
          const accOpt = cmdOpts.find((o) => o && o.name === 'account');
          const accountPuuid = accOpt && accOpt.value ? String(accOpt.value) : undefined;
          const codeOpt = cmdOpts.find((o) => o && o.name === 'code');
          const user = (body.member && body.member.user) || body.user || {};
          const job = (async () => {
            try {
              await fireFollowUp({
                interactionId: body.id,
                token: body.token,
                discordId: discordIdFrom(body),
                name: iname,
                sub,
                puuid: accountPuuid,
                code: codeOpt && codeOpt.value ? String(codeOpt.value) : undefined,
                username: user.username || null,
                ephemeral: Boolean(response.data && response.data.flags & EPHEMERAL),
              });
              console.log(`[int] followup dispatched name=${iname}`);
            } catch (e) {
              console.error(`[int] fireFollowUp FAILED name=${iname} err=${(e && e.message) || e}`);
            }
          })();
          if (waitUntil) waitUntil(job);
          setTimeout(() => console.log('[int] post-res timer alive (no freeze)'), 700);
          res.json(response);
          return;
        }
        console.log(`[int] immediate response type=${response.type} name=${iname}`);
        return res.json(response);
      }

      if (body.type === 3) {
        const customId = (body.data && body.data.custom_id) || '';
        if (customId === 'bundle_select') {
          const bundleId = (body.data && body.data.values && body.data.values[0]) || '';
          console.log(`[int] bundle_select id=${bundleId}`);
          const job = (async () => {
            try {
              await fireFollowUp({ interactionId: body.id, token: body.token, bundleView: 'bundle', bundleId });
            } catch (e) {
              console.error(`[int] bundle select followup FAILED err=${(e && e.message) || e}`);
            }
          })();
          if (waitUntil) waitUntil(job);
          return res.json({ type: 6 });
        }
        if (customId.startsWith('bundle_view:')) {
          // Legacy toggle button (older messages): re-render the full message
          // for the selected bundle now that banner + items are shown together.
          const rest = customId.slice('bundle_view:'.length);
          const sep = rest.indexOf(':');
          const bundleId = sep === -1 ? '' : rest.slice(sep + 1);
          console.log(`[int] bundle_view (legacy) id=${body.id}`);
          const job = (async () => {
            try {
              await fireFollowUp({ interactionId: body.id, token: body.token, bundleView: 'bundle', bundleId });
            } catch (e) {
              console.error(`[int] bundle view followup FAILED err=${(e && e.message) || e}`);
            }
          })();
          if (waitUntil) waitUntil(job);
          return res.json({ type: 6 });
        }
        return res.json({ type: 6 });
      }

      res.status(400).json({ error: 'unknown interaction type' });
    } catch (err) {
      if (err.status && err.status < 500) {
        return res.status(err.status).json({ ok: false, error: err.message });
      }
      next(err);
    }
  }
);

const NO_NIGHT_MARKET = 'There is no Night Market right now. Check back when Riot brings it back.';

// The user's main account, or the given one when it is theirs. null if none.
async function ownAccountFor(discordId, puuid) {
  if (puuid) return storage.getAccount(discordId, puuid).catch(() => null);
  const list = await storage.listAccountsByUser(discordId).catch(() => []);
  return list.find((a) => a.is_default) || list[0] || null;
}

// /share code | import | stop. Every reply is private (deferred ephemerally).
async function shareCommandPayload({ discordId, username, sub, puuid, code }) {
  try {
    if (sub === 'import') {
      const out = await importShareFor(discordId, username, code);
      const by = out.ownerName ? ` from **${out.ownerName}**` : '';
      return buildNotice(
        `## Account added\n**${out.name}**${by} is now in your list as a shared account.\nPick it in the \`account\` option of /shop, /accessories, /nightmarket, /rank or /collection.`
      );
    }
    const acct = await ownAccountFor(discordId, puuid);
    if (!acct) {
      return buildNotice(
        puuid
          ? 'I could not find that account in your own linked accounts. Shared accounts can only be shared by their owner.'
          : 'You have no linked account yet. Run `/link` to open the dashboard and add one.'
      );
    }
    const name = acct.label || acct.name || acct.puuid;
    if (sub === 'stop') {
      const stopped = await revokeShareFor(discordId, acct.puuid);
      return buildNotice(
        stopped
          ? `Stopped sharing **${name}**. Everyone who imported it lost access, and the old code no longer works.`
          : `**${name}** is not shared right now.`
      );
    }
    const out = await createShareFor(discordId, username, acct.puuid);
    const who = out.recipients ? `${out.recipients} ${out.recipients === 1 ? 'person has' : 'people have'} imported it.` : 'Nobody has imported it yet.';
    return buildNotice(
      `## Share code for ${name}\n# \`${out.code}\`\nAnyone with this code can view this account's shops (read-only, they never get your login). They add it with \`/share import\` or on the dashboard.\n-# ${who} Stop sharing any time with \`/share stop\`.`
    );
  } catch (err) {
    return buildNotice(err && err.status && err.status < 500 ? err.message : 'Could not update sharing right now. Try again in a minute.');
  }
}

// /main account: make one of the user's own accounts the default.
async function mainCommandPayload(discordId, puuid) {
  try {
    const acct = await setMainAccount(discordId, puuid);
    return buildNotice(`**${acct.label || acct.name || acct.puuid}** is now your main account. Commands use it when you do not pick one.`);
  } catch (err) {
    return buildNotice(err && err.status && err.status < 500 ? err.message : 'Could not change your main account right now. Try again in a minute.');
  }
}

// Account problems only matter to the person who ran the command, so they go
// out as private notices. `status` is a shopFor/accountDetails status
// ('unlinked' | 'relink' | anything else is treated as a load error).
function accountNotice(status, { shared = false, puuid, what = 'shop', error } = {}) {
  let msg;
  if (status === 'unlinked') {
    msg = shared
      ? 'That shared account is no longer available.'
      : puuid
        ? 'I could not find that linked account. Run the command without choosing an account to see your main one.'
        : 'You have no linked account yet. Run `/link` to open the dashboard and add one.';
  } else if (status === 'relink') {
    msg = shared
      ? 'This shared account needs its owner to re-link it on the dashboard.'
      : 'Your Riot session expired. Run `/link` to open the dashboard, then remove and re-add the account to reconnect.';
  } else {
    msg = `Could not load your ${what} right now${error ? ` (${error})` : ''}. Try again in a few minutes.`;
  }
  return buildNotice(msg, { private: true });
}

// The deferred reply is public and cannot be turned ephemeral after the fact,
// so a private notice is posted as an ephemeral follow-up and the public
// "thinking" placeholder is deleted.
async function sendPrivateNotice(token, payload) {
  const body = { ...payload, flags: (payload.flags || 0) | EPHEMERAL };
  delete body.private;
  const base = `https://discord.com/api/v10/webhooks/${DISCORD_CLIENT_ID}/${token}`;
  const fr = await dfetch(`${base}?with_components=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!fr.ok) console.warn('[interactions] private notice failed:', fr.status, await fr.text().catch(() => ''));
  const dr = await dfetch(`${base}/messages/@original`, { method: 'DELETE' });
  if (!dr.ok && dr.status !== 404) console.warn('[interactions] placeholder delete failed:', dr.status);
}

app.post('/api/interactions/followup', express.json(), async (req, res, next) => {
  try {
    if (req.headers['x-link-secret'] !== LINK_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const { interactionId, token, discordId, name: cmdName, bundleView, bundleId, puuid, sub, code, username, ephemeral } = req.body || {};
    if (!interactionId || !token || (!discordId && !bundleView)) {
      return res.status(400).json({ error: 'bad payload' });
    }

    const isAcc = cmdName === 'accessories';
    console.log(`[int] followup arrived name=${cmdName || bundleView} id=${interactionId}`);
    // Where the time goes, per step, so a slow command can be traced from the logs.
    const t0 = Date.now();
    const laps = [];
    const lap = (label) => laps.push(`${label}=${Date.now() - t0}ms`);
    const wishItems = discordId
      ? await storage
          .getWishlist(discordId)
          .then((w) => [...(w.daily || []), ...(w.accessory || [])])
          .catch(() => null)
      : null;
    lap('wishlist');
    let payload;
    let files = [];
    if (bundleView) {
      payload = await bundlePayload(interactionCtx, { bundleId });
    } else if (cmdName === 'bundle') {
      payload = await bundlePayload(interactionCtx);
    } else if (cmdName === 'share') {
      payload = await shareCommandPayload({ discordId, username, sub, puuid, code });
    } else if (cmdName === 'main') {
      payload = await mainCommandPayload(discordId, puuid);
    } else if (cmdName === 'nightmarket') {
      const result = await shopFor(discordId, puuid || undefined);
      if (result.status !== 'ok') {
        payload = accountNotice(result.status, { shared: result.shared, puuid, what: 'Night Market', error: result.error });
      } else {
        const nm = result.store && result.store.nightMarket;
        if (!nm || !nm.items || !nm.items.length) {
          payload = buildNotice(NO_NIGHT_MARKET);
        } else {
          const gridName = 'nightmarket.png';
          const walletName = 'wallet.png';
          const gridPng = await renderSkinGrid(result.store, { items: nm.items, cols: 3, discount: true, limit: 9, wishlist: wishItems });
          const walletPng = await renderWalletImage(result.store.wallet);
          if (gridPng) files.push({ name: gridName, buf: gridPng });
          if (walletPng) files.push({ name: walletName, buf: walletPng });
          payload =
            buildNightMarketMessage(
              result.store,
              result.account && result.account.name,
              gridPng ? `attachment://${gridName}` : null,
              walletPng ? `attachment://${walletName}` : null
            ) || buildNotice(NO_NIGHT_MARKET);
        }
      }
    } else if (cmdName === 'rank') {
      const access = await accountAccessFor(discordId, puuid || undefined);
      if (!access) {
        payload = accountNotice('unlinked', { puuid });
      } else {
        const result = await shop.accountDetails(access.ownerId, puuid || undefined, { scope: 'rank' });
        if (result.status !== 'ok') {
          payload = accountNotice(result.status, { shared: access.shared, puuid: puuid || true, what: 'rank', error: result.error });
        } else {
          const details = result.details || {};
          const nm = (result.account && (result.account.name || result.account.label)) || null;
          if (!details.rank) {
            // MMR could not be read at all, so there is nothing to draw.
            payload = accountNotice('error', { what: `rank for ${nm || 'this account'}` });
          } else {
            // Unranked accounts get the same card (no placement line, peak if any).
            const rankPng = await renderRankImage(details.rank, { level: details.level && details.level.level }).catch(() => null);
            const imgName = 'rank.png';
            if (rankPng) files.push({ name: imgName, buf: rankPng });
            payload = buildRankMessage(details, nm, rankPng ? `attachment://${imgName}` : null);
          }
        }
      }
    } else if (cmdName === 'collection') {
      const access = await accountAccessFor(discordId, puuid || undefined);
      if (!access) {
        payload = accountNotice('unlinked', { puuid });
      } else {
        const result = await shop.accountDetails(access.ownerId, puuid || undefined, { scope: 'collection' });
        if (result.status !== 'ok') {
          payload = accountNotice(result.status, { shared: access.shared, puuid: puuid || true, what: 'collection', error: result.error });
        } else {
          const cardPng = await renderCollectionImage(collectionColumns(result.details)).catch(() => null);
          const imgName = 'collection.png';
          if (cardPng) files.push({ name: imgName, buf: cardPng });
          payload = buildCollectionMessage(
            result.details,
            (result.account && (result.account.name || result.account.label)) || null,
            cardPng ? `attachment://${imgName}` : null
          );
        }
      }
    } else {
      const result = await shopFor(discordId, puuid || undefined);
      lap('getShop');
      if (result.status !== 'ok') {
        payload = accountNotice(result.status, { shared: result.shared, puuid, what: isAcc ? 'accessory shop' : 'shop', error: result.error });
      } else {
        const ks = result.store && result.store.kingdomShop;
        if (isAcc && (!ks || !ks.items || !ks.items.length)) {
          payload = buildNotice('The accessory shop is empty right now. Try again later.');
        } else {
          const built = await renderShopMessage(result, isAcc, { wishlist: wishItems });
          lap('render');
          payload = built.payload;
          files = files.concat(built.files);
        }
      }
    }
    if (payload.files && payload.files.length) files = files.concat(payload.files);

    const discordPayload = { ...payload };
    delete discordPayload.files;
    delete discordPayload.prewarm;
    // Already-private replies (and bundle menu edits) are edited in place.
    if (discordPayload.private && (bundleView || ephemeral)) delete discordPayload.private;
    if (discordPayload.private) {
      await sendPrivateNotice(token, discordPayload);
      console.log(`[int] followup private notice name=${cmdName || bundleView}`);
      return res.json({ ok: true });
    }
    console.log(
      `[int] payload name=${cmdName || bundleView} keys=${Object.keys(discordPayload).join(',')} embeds=${(discordPayload.embeds || []).length} files=${files.length}`
    );
    let init;
    if (files.length) {
      const fd = new FormData();
      fd.append('payload_json', JSON.stringify(discordPayload));
      files.forEach((f, i) =>
        fd.append(`files[${i}]`, new Blob([f.buf], { type: /\.gif$/i.test(f.name) ? 'image/gif' : 'image/png' }), f.name)
      );
      init = { method: 'PATCH', body: fd };
    } else {
      init = {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload),
      };
    }
    const v2 = Array.isArray(discordPayload.components);
    const editUrl =
      `https://discord.com/api/v10/webhooks/${DISCORD_CLIENT_ID}/${token}/messages/@original` +
      (v2 ? '?with_components=true' : '');
    lap('payload');
    const dr = await dfetch(editUrl, init);
    lap('patch');
    if (!dr.ok) console.warn('[interactions] follow-up PATCH failed:', dr.status, await dr.text().catch(() => ''));
    else console.log(`[int] followup patched ok status=${dr.status}`);
    console.log(`[time] followup name=${cmdName || bundleView} total=${Date.now() - t0}ms ${laps.join(' ')}`);
    res.json({ ok: true });
    // /bundle: the first bundle is out, so render the others now (kept alive past the
    // response) and a switch in the menu finds them ready.
    if (cmdName === 'bundle' && payload.prewarm) {
      const job = prewarmBundles(interactionCtx, payload.prewarm.bundles, payload.prewarm.selectedId).catch(() => {});
      if (waitUntil) waitUntil(job);
    }
  } catch (err) {
    console.error(`[int] followup FAILED name=${cmdName || bundleView} id=${interactionId} err=${(err && err.stack) || err}`);
    dcLog.sendLog(`${dcLog.adminMention()} followup failed: ${cmdName || bundleView} for ${dcLog.userMention(discordId || '?')}: ${String((err && err.message) || err).slice(0, 200)}`, { ping: true });
    try {
      const crash = 'Something went wrong loading that. Try the command again in a minute.';
      if (token && !bundleView && !ephemeral) {
        await sendPrivateNotice(token, buildNotice(crash, { private: true }));
      } else if (token) {
        // Bundle menu clicks edit the existing bundle message in place; never
        // delete it, just swap in the notice.
        await dfetch(`https://discord.com/api/v10/webhooks/${DISCORD_CLIENT_ID}/${token}/messages/@original?with_components=true`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildNotice(crash)),
        });
      }
    } catch {
      /* best effort: the interaction may already be gone */
    }
    res.json({ ok: true });
  }
});

// ---- Skin grid image --------------------------------------------------------

// Internal use requires the link secret; the dashboard viewer additionally
// allows a logged-in Discord user to render their own accounts only.
function gridAllowed(req, ownerDiscordId) {
  if ((req.query.secret || req.headers['x-link-secret']) === LINK_SECRET) return true;
  const me = req.session && req.session.discordId;
  return Boolean(me && (!ownerDiscordId || me === String(ownerDiscordId)));
}

app.get('/api/skin-grid', async (req, res) => {
  try {
    if (!gridAllowed(req, String(req.query.id || ''))) return res.status(403).end();
    const id = String(req.query.id || '');
    if (!/^\d{5,25}$/.test(id)) return res.status(400).end();
    const account = await storage.getAccount(id);
    if (!account || !account.store_cache) return res.status(404).end();
    let png;
    if (req.query.type === 'wallet') {
      png = await renderWalletImage(account.store_cache.wallet);
    } else if (req.query.type === 'accessory') {
      const ks = account.store_cache.kingdomShop;
      png =
        ks && ks.items && ks.items.length
          ? await renderSkinGrid(account.store_cache, { items: ks.items, limit: 8, showType: true })
          : null;
    } else {
      png = await renderSkinGrid(account.store_cache);
    }
    if (!png) return res.status(404).end();
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800',
    });
    res.end(png);
  } catch (err) {
    console.warn('[skin-grid]', err.message);
    res.status(502).end();
  }
});

// ---- Bundle items grid image ------------------------------------------------

app.get('/api/bundle-grid', async (req, res) => {
  try {
    if (!gridAllowed(req, null)) return res.status(403).end();
    const bundleId = String(req.query.b || '');
    if (!bundleId) return res.status(400).end();
    const account = await storage.getAccount(BUNDLE_SOURCE_ID);
    const bundles = (account && account.store_cache && account.store_cache.bundles) || [];
    const bundle = bundles.find((b) => b && String(b.id) === bundleId);
    if (!bundle || !bundle.items || !bundle.items.length) return res.status(404).end();
    await items.load().catch(() => {});
    const png = await renderBundleGrid(bundle.items);
    if (!png) return res.status(404).end();
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800',
    });
    res.end(png);
  } catch (err) {
    console.warn('[bundle-grid]', err.message);
    res.status(502).end();
  }
});

// ---- Cron --------------------------------------------------------------------

// Cron endpoints accept Vercel's CRON_SECRET bearer, the internal link secret,
// or a dedicated SCHEDULER_SECRET (used by the external exact-time scheduler).
function cronAuthorized(req) {
  const secureSecret = process.env.CRON_SECRET || LINK_SECRET;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const scheduler = String(req.headers['x-scheduler-secret'] || req.query.key || '');
  return (
    req.query.secret === secureSecret ||
    req.headers['x-link-secret'] === LINK_SECRET ||
    bearer === secureSecret ||
    (SCHEDULER_SECRET !== '' && scheduler === SCHEDULER_SECRET)
  );
}

app.get('/api/cron/refresh', async (req, res, next) => {
  try {
    if (!cronAuthorized(req)) return res.status(403).json({ error: 'forbidden' });

    const accounts = await storage.listAccounts();
    let needed = 0;
    let refreshed = 0;
    let relink = 0;
    let failed = 0;
    const failLines = [];
    const relinkAccounts = [];
    for (const acct of accounts) {
      let auth;
      try {
        auth = storage.decrypt(acct.auth_encrypted);
      } catch {
        continue;
      }
      if (auth.access_token && auth.expires_at && auth.expires_at > Date.now() + 15 * 60 * 1000) {
        continue;
      }
      if (!auth.refresh_token && !auth.cookies) {
        relink++;
        relinkAccounts.push(acct);
        continue;
      }
      needed++;
      try {
        let fresh = null;
        try {
          fresh = await shop.refreshTokens(acct.discord_id, acct.puuid, auth);
        } catch (e) {
          if (e && e.code === 'REVOKED') {
            relink++;
            relinkAccounts.push(acct);
          } else failed++;
          continue;
        }
        if (!fresh) {
          failed++;
          continue;
        }
        if (fresh.access_token) auth.access_token = fresh.access_token;
        if (fresh.id_token) auth.id_token = fresh.id_token;
        if (fresh.expires_at) auth.expires_at = fresh.expires_at;
        auth.refresh_token = fresh.refresh_token;
        if (fresh.cookies) auth.cookies = fresh.cookies;
        await storage.saveAccount(acct.discord_id, acct.puuid, { auth_encrypted: storage.encrypt(auth) });
        refreshed++;
      } catch (e) {
        const msg = (e && e.message) || e;
        console.warn(`[cron] refresh failed for ${acct.discord_id}: ${msg}`);
        failLines.push(`${acct.discord_id}: ${String(msg).slice(0, 160)}`);
        failed++;
      }
    }
    // Tell each owner once (per week) that an account needs re-linking, so a
    // silent Riot sign-out doesn't just quietly pause their shops and alerts.
    let relinkDmed = 0;
    for (const acct of relinkAccounts) {
      try {
        const key = `relinknotify:${acct.discord_id}:${acct.puuid}`;
        const seen = await storage.kvGet(key).catch(() => null);
        if (seen && seen.at && Date.now() - Number(seen.at) < 7 * 24 * 60 * 60 * 1000) continue;
        await sendDirectMessage(
          acct.discord_id,
          {
            content: [
              '**Account needs re-linking**',
              `Riot signed out **${accountDisplayName(acct)}** (${String(acct.shard || '?').toUpperCase()}), so its shop and alerts are paused until you re-add it.`,
              `Re-add it on the dashboard: ${APP_URL}`,
            ].join('\n'),
          },
          []
        );
        await storage.kvSet(key, { at: Date.now() }, 7 * 24 * 60 * 60 * 1000).catch(() => {});
        relinkDmed++;
      } catch (e) {
        console.warn(`[cron] relink DM failed for ${acct.discord_id}: ${(e && e.message) || e}`);
      }
    }
    {
      const summary = `Token refresh: checked=${accounts.length} needed=${needed} refreshed=${refreshed} relink=${relink} failed=${failed} relink_dmed=${relinkDmed}`;
      dcLog.sendLog(
        failed > 0
          ? `${dcLog.adminMention()} ${summary}\n${failLines.slice(0, 10).join('\n')}`
          : summary,
        { ping: failed > 0 }
      );
    }
    res.json({ ok: true, checked: accounts.length, needed, refreshed, relink, failed, relinkDmed });
  } catch (err) {
    next(err);
  }
});

// Prefs with a one-time import of the retired /dailyshop subscription.
async function loadPrefsWithLegacy(discordId) {
  const prefs = await storage.getPrefs(discordId);
  const hasAny = prefs.nm || prefs.bundle || Object.keys(prefs.accounts || {}).length > 0;
  if (!hasAny) {
    const legacy = await storage.kvGet(`dailyshop:${discordId}`).catch(() => null);
    if (legacy) {
      const def = await storage.getAccount(discordId).catch(() => null);
      if (def && def.puuid) {
        prefs.accounts = { [def.puuid]: { shop: true, accessory: false } };
        await storage.setPrefs(discordId, prefs).catch(() => {});
      }
      await storage.kvDel(`dailyshop:${discordId}`).catch(() => {});
    }
  }
  return prefs;
}

function accountDisplayName(acct) {
  return (acct && (acct.label || acct.name)) || 'your account';
}

function utcDayStart() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

// Rotation instants are derived as fetchTime + remainingDuration, so two fetches
// of the *same* rotation land a few seconds apart. Real rotations are at least a
// day apart, so compare with generous slack: a jittery recomputation must never
// be mistaken for a fresh rotation (which re-fired the DM every day).
const ROTATION_SLACK_MS = 15 * 60 * 1000;
function sameRotation(a, b) {
  return Boolean(a) && Boolean(b) && Math.abs(a - b) < ROTATION_SLACK_MS;
}

// Names of wishlisted items present in a shop's item list, matched by id or
// normalized name (handles base-vs-skin-level uuid differences). Deduped.
function wishlistMatchItems(list, storeItems) {
  if (!list || !list.length || !storeItems || !storeItems.length) return [];
  const nameKey = items.normalizeName;
  const idSet = new Set(list.map((x) => String(x.id)));
  const nameSet = new Set(list.map((x) => nameKey(x.name)).filter(Boolean));
  const seen = new Set();
  const out = [];
  for (const it of storeItems) {
    if (!it) continue;
    const hit = idSet.has(String(it.id)) || nameSet.has(nameKey(it.name));
    if (!hit) continue;
    const k = nameKey(it.name);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function wishlistMatches(list, storeItems) {
  return wishlistMatchItems(list, storeItems).map((it) => it.name || 'Wishlisted item');
}

// Night Market wishlist alert text. Spoiler free by default: it only says an
// item from the wishlist is in the Night Market ("items" when there are more),
// so the in-game reveal stays a surprise. With `names` it lists each item and
// its discount. `hits` is [{ name, matches: [item], expiresAt }].
function nightMarketWishlistText(hits, names) {
  const closes = Math.max(...hits.map((h) => h.expiresAt || 0));
  const lines = ['**Night Market wishlist alert**'];
  if (closes) lines.push(`-# Closes <t:${Math.floor(closes / 1000)}:R>`);
  if (names) {
    for (const h of hits) {
      if (hits.length > 1) lines.push(`\`${h.name}\``);
      for (const it of h.matches) lines.push(`• ${it.name || 'Wishlisted item'}${it.discount ? ` (-${it.discount}%)` : ''}`);
    }
  } else if (hits.length === 1) {
    const h = hits[0];
    lines.push(
      h.matches.length === 1
        ? `An item from your wishlist is in your Night Market on \`${h.name}\`.`
        : `Items from your wishlist are in your Night Market on \`${h.name}\`.`
    );
  } else {
    for (const h of hits) lines.push(`• \`${h.name}\`: ${h.matches.length === 1 ? 'an item' : 'items'} from your wishlist`);
  }
  lines.push(`-# Open the dashboard (${APP_URL}) or run /nightmarket to see it.`);
  return lines.join('\n');
}

// A rotation with less than this left is the previous one: Riot has not flipped
// the shop yet. Sending then would DM yesterday's shop, so wait (bounded) for it.
const ROTATION_GRACE_MS = 2 * 60 * 1000;
const ROTATION_POLL_MS = 8000;
const ROTATION_WAIT_MS = 35 * 1000;
const DAILY_CONCURRENCY = 8;

function staleRotation(store) {
  const end = store && store.daily && store.daily.expiresAt;
  return Boolean(end) && end - Date.now() < ROTATION_GRACE_MS;
}

async function waitForRotation(result, discordId, puuid, until) {
  let r = result;
  while (r && r.status === 'ok' && staleRotation(r.store) && Date.now() + ROTATION_POLL_MS < until) {
    await new Promise((resolve) => setTimeout(resolve, ROTATION_POLL_MS));
    r = await shop.getShop(discordId, puuid, { force: true }).catch(() => r);
  }
  return r;
}

// Runs fn over items with at most `limit` in flight. fn must not throw.
async function runPool(list, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const item = list[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

app.get('/api/cron/dailyshop', async (req, res, next) => {
  try {
    if (!cronAuthorized(req)) return res.status(403).json({ error: 'forbidden' });
    const t0 = Date.now();

    const prefRows = await storage.kvList('alertprefs:').catch(() => []);
    const legacyRows = await storage.kvList('dailyshop:').catch(() => []);
    const wishRows = await storage.kvList('wishlist:').catch(() => []);
    const ids = new Set();
    for (const r of prefRows) ids.add(String(r.key).slice('alertprefs:'.length));
    for (const r of legacyRows) ids.add(String(r.key).slice('dailyshop:'.length));
    for (const r of wishRows) ids.add(String(r.key).slice('wishlist:'.length));

    let users = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let nmSent = 0;
    let wishlistSent = 0;
    const okLines = [];
    const failLines = [];
    const rotationDeadline = t0 + ROTATION_WAIT_MS;
    const processUser = async (discordId) => {
      users++;
      let userSent = 0;
      let userFail = null;
      try {
        const prefs = await loadPrefsWithLegacy(discordId);
        const accounts = await storage.listAccountsByUser(discordId).catch(() => []);
        if (!accounts.length) return;
        const wishItems = await storage
          .getWishlist(discordId)
          .then((w) => [...(w.daily || []), ...(w.accessory || [])])
          .catch(() => null);
        const results = new Map();
        await Promise.all(
          accounts.map(async (acct) => {
            const first = await shop
              .getShop(discordId, acct.puuid)
              .catch((e) => ({ status: 'error', error: (e && e.message) || e }));
            results.set(acct.puuid, await waitForRotation(first, discordId, acct.puuid, rotationDeadline));
          })
        );
        for (const acct of accounts) {
          const toggle = (prefs.accounts && prefs.accounts[acct.puuid]) || {};
          if (toggle.shop !== true && toggle.accessory !== true) continue;
          try {
            const result = results.get(acct.puuid);
            if (!result || result.status !== 'ok' || staleRotation(result.store)) {
              // Not rotated yet: no marker is written, so the next trigger retries.
              skipped++;
              continue;
            }
            const rotAt =
              (result.store && result.store.daily && result.store.daily.expiresAt) || utcDayStart();
            const ks = result.store && result.store.kingdomShop;
            const accRot = ks && ks.expiresAt;
            const shopKey = `dailyshop_sent:${discordId}:${acct.puuid}`;
            const shopMarker = await storage.kvGet(shopKey).catch(() => null);
            const shopDue = toggle.shop === true && !sameRotation(shopMarker && shopMarker.at, rotAt);
            const accKey = `accshop_sent:${discordId}:${acct.puuid}`;
            const accMarker = await storage.kvGet(accKey).catch(() => null);
            const accDue = toggle.accessory === true && Boolean(accRot) && !sameRotation(accMarker && accMarker.at, accRot);
            if (!shopDue && !accDue) {
              skipped++;
              continue;
            }
            const { payload, files } = await renderDailyDm(result, { shop: shopDue, accessory: accDue, manageUrl: APP_URL, wishlist: wishItems });
            if (!payload) {
              skipped++;
              continue;
            }
            await sendDirectMessage(discordId, payload, files);
            sent++;
            userSent++;
            if (shopDue) await storage.kvSet(shopKey, { at: rotAt }, 3 * 24 * 60 * 60 * 1000).catch(() => {});
            if (accDue) await storage.kvSet(accKey, { at: accRot }, 14 * 24 * 60 * 60 * 1000).catch(() => {});
          } catch (e) {
            failed++;
            const msg = (e && e.message) || String(e);
            console.warn(`[dailyshop] ${discordId} failed: ${msg}`);
            if (!userFail) userFail = msg;
            if (e && e.status === 403) break;
          }
        }
        // Global Night Market alert: one DM per event across all accounts.
        if (prefs.nm === true) {
          const marker = await storage.kvGet(`nm_announced:${discordId}`).catch(() => null);
          const announcedAt = marker && marker.at;
          let liveAt = 0;
          const liveNames = [];
          for (const acct of accounts) {
            const result = results.get(acct.puuid);
            const nm = result && result.status === 'ok' && result.store && result.store.nightMarket;
            if (nm && nm.items && nm.items.length && nm.expiresAt) {
              if (nm.expiresAt > liveAt) liveAt = nm.expiresAt;
              liveNames.push(accountDisplayName(result.account));
            }
          }
          if (liveAt && !sameRotation(liveAt, announcedAt)) {
            const shown =
              liveNames.slice(0, 5).join(', ') + (liveNames.length > 5 ? ` and ${liveNames.length - 5} more` : '');
            await sendDirectMessage(
              discordId,
              {
                content: `Night Market is available on ${shown}. Open the dashboard (${APP_URL}) or run /nightmarket to see the offers.`,
              },
              []
            );
            await storage.kvSet(`nm_announced:${discordId}`, { at: liveAt }, 60 * 24 * 60 * 60 * 1000).catch(() => {});
            nmSent++;
            okLines.push(`Night Market alert sent to ${dcLog.userMention(discordId)} (${liveNames.length} account(s)).`);
          }
        }
        // Night Market wishlist alert: global like the Night Market alert, one DM
        // per event across accounts, only when a wishlisted skin is among an
        // account's offers. Each account is marked once per Night Market (and
        // per item), so a later wishlist addition still alerts.
        if (prefs.wishlist_nm === true) {
          const wlNm = await storage.getWishlist(discordId).catch(() => ({ daily: [], accessory: [] }));
          const hits = [];
          for (const acct of accounts) {
            const result = results.get(acct.puuid);
            const nm = result && result.status === 'ok' && result.store && result.store.nightMarket;
            if (!nm || !nm.items || !nm.items.length || !nm.expiresAt) continue;
            const matches = wishlistMatchItems(wlNm.daily, nm.items);
            if (!matches.length) continue;
            const markerKey = `wishlist_nm_notify:${discordId}:${acct.puuid}`;
            const nmMarker = await storage.kvGet(markerKey).catch(() => null);
            const sameRot = sameRotation(nmMarker && nmMarker.at, nm.expiresAt);
            const already = new Set(sameRot && Array.isArray(nmMarker.ids) ? nmMarker.ids : []);
            const fresh = matches.filter((m) => !already.has(m.name));
            if (!fresh.length) continue;
            hits.push({ name: accountDisplayName(acct), matches: fresh, expiresAt: nm.expiresAt, markerKey, ids: [...already, ...fresh.map((m) => m.name)], at: nm.expiresAt });
          }
          if (hits.length) {
            try {
              await sendDirectMessage(discordId, { content: nightMarketWishlistText(hits, prefs.nm_names === true) }, []);
              for (const h of hits) await storage.kvSet(h.markerKey, { at: h.at, ids: h.ids }, 30 * 24 * 60 * 60 * 1000).catch(() => {});
              wishlistSent++;
              okLines.push(`Night Market wishlist alert sent to ${dcLog.userMention(discordId)} (${hits.length} account(s)).`);
            } catch (e) {
              failed++;
              const msg = (e && e.message) || String(e);
              console.warn(`[dailyshop] nm wishlist ${discordId} failed: ${msg}`);
              if (!userFail) userFail = msg;
            }
          }
        }
        // Wishlist alerts: split into a shop alert and an accessory alert, each
        // gated by its own toggle. Fires when a wishlisted item appears; deduped
        // per rotation so each item alerts once per shop reset.
        const followed = accounts.filter((a) => {
          const t = (prefs.accounts && prefs.accounts[a.puuid]) || {};
          return t.wishlist_shop === true || t.wishlist_accessory === true;
        });
        if (followed.length) {
          const wl = await storage.getWishlist(discordId).catch(() => ({ daily: [], accessory: [] }));
          acctLoop: for (const acct of followed) {
            const result = results.get(acct.puuid);
            if (!result || result.status !== 'ok' || !result.store) continue;
            const toggle = (prefs.accounts && prefs.accounts[acct.puuid]) || {};
            const scopes = [
              { key: 'daily', title: 'Shop wishlist alert', on: toggle.wishlist_shop === true, store: result.store.daily },
              { key: 'accessory', title: 'Accessory wishlist alert', on: toggle.wishlist_accessory === true, store: result.store.kingdomShop },
            ];
            for (const scope of scopes) {
              const matches = wishlistMatches(wl[scope.key], scope.store && scope.store.items);
              if (!matches.length) continue;
              const at = (scope.store && scope.store.expiresAt) || utcDayStart();
              const markerKey = `wishlist_notify:${discordId}:${acct.puuid}:${scope.key}`;
              const marker = await storage.kvGet(markerKey).catch(() => null);
              const sameRot = sameRotation(marker && marker.at, at);
              const already = new Set(sameRot && Array.isArray(marker.ids) ? marker.ids : []);
              const next = matches.filter((n) => !already.has(n));
              const idsForMarker = sameRot ? [...new Set([...already, ...matches])] : matches;
              await storage
                .kvSet(markerKey, { at, ids: idsForMarker }, 8 * 24 * 60 * 60 * 1000)
                .catch(() => {});
              if (!scope.on || !next.length) continue;
              try {
                const lines = [`**${scope.title}** - \`${accountDisplayName(acct)}\``];
                if (at) lines.push(`-# resets <t:${Math.floor(at / 1000)}:R>`);
                for (const item of next) lines.push(`• ${item}`);
                await sendDirectMessage(discordId, { content: lines.join('\n') }, []);
                wishlistSent++;
                okLines.push(`${scope.title} sent to ${dcLog.userMention(discordId)} for ${accountDisplayName(acct)}.`);
              } catch (e) {
                failed++;
                const msg = (e && e.message) || String(e);
                console.warn(`[dailyshop] wishlist ${discordId} failed: ${msg}`);
                if (!userFail) userFail = msg;
                if (e && e.status === 403) break acctLoop;
              }
            }
          }
        }
        if (userSent > 0) okLines.push(`Daily shop sent to ${dcLog.userMention(discordId)} for ${userSent} account(s).`);
        if (userFail) failLines.push(`Daily shop failed for ${dcLog.userMention(discordId)}: ${String(userFail).slice(0, 200)}`);
      } catch (e) {
        failed++;
        const msg = (e && e.message) || e;
        console.warn(`[dailyshop] user ${discordId} failed: ${msg}`);
        failLines.push(`Daily shop failed for ${dcLog.userMention(discordId)}: ${String(msg).slice(0, 200)}`);
      }
    };
    await runPool([...ids], DAILY_CONCURRENCY, processUser);
    // Only post a summary when the run actually did something (or hit a failure).
    // This keeps the standalone `vercel` fallback silent when the primary
    // scheduler already handled the day, so there is one clean summary per day.
    if (sent > 0 || failed > 0 || nmSent > 0 || wishlistSent > 0) {
      const finished = new Date();
      const date = finished.toISOString().slice(0, 10);
      const at = `${finished.toISOString().slice(11, 16)}Z`;
      const source =
        req.headers['x-scheduler-secret'] || req.query.key
          ? 'scheduler'
          : req.headers.authorization
            ? 'vercel'
            : 'other';
      const sec = ((Date.now() - t0) / 1000).toFixed(1);
      const summary = `Daily shops ${date} ${at} [${source}]: ${users} user(s), ${sent} sent, ${skipped} skipped, ${failed} failed, ${nmSent} NM alert(s), ${wishlistSent} wishlist alert(s). (${sec}s)`;
      const lines = [...failLines.slice(0, 10), ...okLines.slice(0, 15)];
      // Awaited so the fire-and-forget POST is not cut off when the lambda freezes.
      await dcLog.sendLog(failLines.length > 0 ? `${dcLog.adminMention()} ${summary}\n${lines.join('\n')}` : `${summary}\n${lines.join('\n')}`, { ping: failLines.length > 0 });
    }
    res.json({ ok: true, users, sent, skipped, failed, nmSent, wishlistSent, ms: Date.now() - t0 });
  } catch (err) {
    next(err);
  }
});

// ---- New-bundle alerts -------------------------------------------------------
// Bundles are read from the shared source account (rito dev#meow), never from
// the visitor's own accounts. A bundle is "new" when its id has not been seen
// before; each live bundle is tracked independently so 1, 2 or 3 simultaneous
// bundles are all handled (never assume a new one only replaces an old one).

const BUNDLE_SEEN_KEY = 'bundle_seen';
// Keep a bundle id remembered for this long after it stops appearing, so a
// transient blip in the storefront response cannot look like a fresh release.
const BUNDLE_SEEN_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

// Returns the deduped list of live bundles, or null when the data is unknown
// (fetch failed, or the response carried no bundles at all) so the caller can
// leave its "already announced" marker untouched.
async function fetchSourceBundles() {
  const result = await shop
    .getShop(BUNDLE_SOURCE_ID, undefined, { force: true, owned: false })
    .catch((e) => ({ status: 'error', error: (e && e.message) || e }));
  let bundles = result.status === 'ok' && result.store ? result.store.bundles || [] : [];
  let reliable = result.status === 'ok';
  if (!bundles.length) {
    const acct = await storage.getAccount(BUNDLE_SOURCE_ID).catch(() => null);
    const stale = acct && acct.store_cache && acct.store_cache.bundles;
    if (stale && stale.length) {
      bundles = stale;
      reliable = true;
    }
  }
  bundles = dedupeBundles(bundles).filter((b) => b && b.id);
  if (!reliable || !bundles.length) return null;
  shop.rememberBundles(bundles).catch(() => {});
  return bundles;
}

// Renders a single bundle as a standalone DM: banner art + items grid + price,
// so the message needs no interaction to show its contents.
async function buildBundleAlert(bundle) {
  const files = [];
  let imageRefs;
  if (bundle.items && bundle.items.length) {
    const media = await renderBundleMedia(bundle.items).catch(() => null);
    if (media) {
      files.push(media);
      imageRefs = { [bundle.id]: `attachment://${media.name}` };
    }
  }
  const payload = buildBundleMessage([bundle], {
    selectedId: bundle.id,
    imageRefs,
    footer: alertFooter(APP_URL),
    accentColor: await bundleAccentColor(bundle.art),
  });
  return { payload, files };
}

async function runBundleCheck() {
  const tFetch = Date.now();
  const bundles = await fetchSourceBundles();
  console.log(`[time] cron bundles fetch=${Date.now() - tFetch}ms`);
  if (!bundles) return { ok: true, checked: false, newCount: 0, sent: 0, failed: 0 };
  const now = Date.now();
  const marker = await storage.kvGet(BUNDLE_SEEN_KEY).catch(() => null);
  const known = marker && marker.ids && typeof marker.ids === 'object' ? marker.ids : null;
  const firstRun = !known;

  // Next seen map = every live bundle (refreshed), plus recently-seen ids that
  // have not yet aged out (so a reappearing bundle re-alerts, but a one-off
  // blip does not).
  const next = {};
  for (const b of bundles) next[b.id] = now;
  if (known) {
    for (const [id, ts] of Object.entries(known)) {
      if (!(id in next) && now - Number(ts || 0) < BUNDLE_SEEN_RETENTION_MS) next[id] = Number(ts) || now;
    }
  }

  const fresh = firstRun ? [] : bundles.filter((b) => !(b.id in known));
  // Persist before sending so a duplicate/overlapping invocation cannot double-send.
  await storage.kvSet(BUNDLE_SEEN_KEY, { ids: next, at: now }, 60 * 24 * 60 * 60 * 1000).catch(() => {});

  if (firstRun) {
    console.log(`[bundle-alert] baseline set (${bundles.length} bundle(s) recorded, no alerts)`);
    return { ok: true, checked: true, baseline: true, newCount: 0, sent: 0, failed: 0 };
  }
  if (!fresh.length) return { ok: true, checked: true, newCount: 0, sent: 0, failed: 0 };

  const prefRows = await storage.kvList('alertprefs:').catch(() => []);
  const recipients = [];
  for (const row of prefRows) {
    const discordId = String(row.key).slice('alertprefs:'.length);
    const prefs = await storage.getPrefs(discordId).catch(() => null);
    if (prefs && prefs.bundle === true) recipients.push(discordId);
  }

  let sent = 0;
  let failed = 0;
  const names = [];
  for (const bundle of fresh) {
    names.push(bundle.name || 'Featured Bundle');
    console.log(`[bundle-alert] new bundle id=${bundle.id} name=${bundle.name} recipients=${recipients.length}`);
    if (!recipients.length) continue;
    let alert;
    try {
      alert = await buildBundleAlert(bundle);
    } catch (e) {
      failed += recipients.length;
      console.warn(`[bundle-alert] render failed for ${bundle.id}: ${(e && e.message) || e}`);
      continue;
    }
    // A few DMs at a time: sending them one by one made the last subscriber wait for everyone before.
    let next = 0;
    const worker = async () => {
      while (next < recipients.length) {
        const discordId = recipients[next++];
        try {
          await sendDirectMessage(discordId, alert.payload, alert.files);
          sent++;
        } catch (e) {
          failed++;
          console.warn(`[bundle-alert] ${discordId} failed: ${(e && e.message) || e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, recipients.length) }, worker));
  }

  const summary = `New bundle alert: ${names.join(', ')}. ${sent} sent, ${failed} failed, ${recipients.length} subscriber(s).`;
  await dcLog.sendLog(failed > 0 ? `${dcLog.adminMention()} ${summary}` : summary, { ping: failed > 0 });
  return { ok: true, checked: true, newCount: fresh.length, sent, failed, recipients: recipients.length, names };
}

// External schedulers give up after ~30s (cron-job.org's free plan) and mark the run
// as failed. The check keeps running to the end, but the reply goes out at 25s at the latest.
const CRON_REPLY_DEADLINE_MS = 25 * 1000;

app.get('/api/cron/bundles', async (req, res, next) => {
  try {
    if (!cronAuthorized(req)) return res.status(403).json({ error: 'forbidden' });
    const t0 = Date.now();
    // ?warm=1 (sent a minute before the check) only primes the token and catalog.
    if (req.query.warm === '1') {
      const warmed = await shop.warmAccount(BUNDLE_SOURCE_ID, undefined).catch(() => false);
      console.log(`[time] cron bundles warm ${warmed ? 'ok' : 'failed'} in ${Date.now() - t0}ms`);
      return res.json({ ok: true, warm: true, warmed });
    }
    const job = runBundleCheck().then((out) => ({ ...out, ms: Date.now() - t0 }));
    job.catch((e) => console.error(`[cron] bundles failed: ${(e && e.stack) || e}`));
    if (waitUntil) waitUntil(job.catch(() => {}));
    let timer;
    const slow = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: true, pending: true, ms: Date.now() - t0 }), CRON_REPLY_DEADLINE_MS);
    });
    const out = await Promise.race([job, slow]).finally(() => clearTimeout(timer));
    console.log(`[time] cron bundles ${out.pending ? 'still running at ' : 'done in '}${Date.now() - t0}ms`);
    res.json(out);
  } catch (err) {
    next(err);
  }
});

app.get('/health', async (req, res) => {
  let storageStatus = storage.isConfigured() ? 'supabase' : 'memory';
  try {
    if (storage.isConfigured()) {
      await storage.kvSet('__health__', { t: Date.now() }, 60000);
      await storage.kvDel('__health__');
    }
  } catch (err) {
    return res.status(503).json({ ok: false, storage: storageStatus, error: err.message });
  }
  res.json({ ok: true, storage: storageStatus });
});

// ---- Shared ---------------------------------------------------------------

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({ ok: false, error: err.message || 'Unexpected error', status });
});

items.load().catch((err) => console.warn('[items] catalog load failed:', err.message));

module.exports = app;
module.exports.linkAccount = linkAccount;
module.exports.wipeUserData = wipeUserData;