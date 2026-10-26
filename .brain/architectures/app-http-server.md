---
id: arch-app-http-server
type: architecture
title: App HTTP Server (app.js)
target_files:
  - app.js
  - website/index.html
  - website/dashboard.js
tags: [express, http, dashboard, routing]
updated: 2026-10-26
---

# Architecture: App HTTP Server (app.js)

## Target Files & Scope
- `app.js` (~2400 lines): Single Express app. Exports `app` plus `app.linkAccount`. Holds all HTTP routes, middleware, Discord interaction handling, and cron jobs. No `listen()` here.
- `website/index.html`: Dashboard shell. Read once at boot into `INDEX_HTML`.
- `website/dashboard.js`: Dashboard client. Talks to `/api/*` with the session cookie.

Related notes: [discord-bot](discord-bot.md), [cron-jobs](cron-jobs.md), [shop-service](shop-service.md), [storage](storage.md).

## Boot
- Loads `.env` with `process.loadEnvFile`. Missing file is fine (Vercel injects env).
- Throws at boot when `SESSION_SECRET` or `LINK_SECRET` is missing. No ephemeral fallback.
- Env read here: `PORT`, `BASE_URL`, `APP_URL`, `BASE_PATH`, `RIOT_DEV_API_KEY`, `SESSION_SECRET`, `LINK_SECRET`, `SCHEDULER_SECRET`, `CRON_SECRET`, `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `CANONICAL_HOME`, `WEBSITE_ENABLED`.

## Middleware Order (top to bottom, order matters)
1. `trust proxy` = 1.
2. Canonical host redirect: any `*.vercel.app` hit gets 307 to `CANONICAL_HOME` (default `https://xhv.sh/valorant-shop`). Exempt: paths under `BASE_PATH`, `/api/cron`, `/api/interactions`, `/health`.
3. Subpath mount: when `BASE_PATH` is set, `${BASE_PATH}/x` is rewritten to `/x`. Sets `req.mountPath` and `res.locals.mountPath`. App stays reachable at root too.
4. `express-session`: cookie `valshops.sid`, 30 days, `httpOnly`, `sameSite=lax`, `secure` when `BASE_URL` is https. Store = `PackageStore` (`src/session.js`).
5. Security headers: strict CSP (`script-src 'self'`, no inline scripts), `X-Frame-Options: DENY`, `nosniff`, Permissions-Policy.
6. Website gate: `WEBSITE_ENABLED=false` leaves only `BOT_PATHS` (`/link`, `/api/interactions`, the 3 cron paths, grid images, `/health`).
7. JSON body parser on everything EXCEPT `/api/interactions` (needs raw bytes for Ed25519).
8. `/` and `/index.html`: served from memory via `renderIndexHtml(mountPath)`. Under a mount it rewrites absolute `href`/`src` and injects `<base href>`. `Cache-Control: no-store`.
9. `express.static('website')`: fonts cached 7 days, other assets 1 hour.

## Auth Model
- Website identity = Discord OAuth (`scope=identify`). `GET /auth/discord` sets `discordOauthState`. `GET /auth/discord/callback` checks state, then stores `discordId`, `discordName`, `discordAvatar` in the session.
- `requireDiscord` middleware guards the dashboard API.
- Riot accounts attach to the Discord user through the add-account flow below. There is no Riot-only login on the dashboard.

## Route Map
| Area | Routes |
| :--- | :--- |
| Meta | `GET /api/me`, `/api/install`, `/api/version`, `/api/stats`, `/health` |
| Accounts | `GET /api/accounts`, `POST /api/accounts/default`, `DELETE /api/accounts/:puuid`, `GET /api/accounts/:puuid/details` |
| Add account | `POST /api/accounts/add/start`, `POST /api/accounts/add/complete` |
| Prefs | `GET/PUT /api/prefs` (full replace), `PATCH /api/prefs` (partial merge: per-account alerts, `nm`, `bundle`, `order`) |
| Sharing | `POST/GET /api/shares`, `DELETE /api/shares/:code`, `DELETE /api/shares/:code/recipients/:granteeId`, `POST /api/shares/:puuid/rotate`, `POST /api/shares/import`, `DELETE /api/shares/imported/:puuid` |
| Wishlist | `GET/POST /api/wishlist`, `DELETE /api/wishlist/:id`, `POST /api/wishlist/batch` |
| Catalog | `GET /api/items/search`, `/api/items/index`, `/api/item` |
| Store | `GET /api/shop`, `GET /api/bundles` |
| Images | `GET /api/skin-grid`, `GET /api/bundle-grid` |
| Discord | `POST /api/interactions`, `POST /api/interactions/followup` |
| Cron | `GET /api/cron/refresh`, `/api/cron/dailyshop`, `/api/cron/bundles` |
| Session | `POST /auth/logout`, `GET /link` (redirect to `/`) |
| Data wipe | `POST /api/me/delete` (body `{confirm: "DELETE"}`): `wipeUserData` removes accounts, prefs, wishlist, owned shares (recipients lose access), imported shares, markers and sessions |
| Pages | `GET /legal`; dashboard routes `/wishlist`, `/bundles`, `/settings`, `/a/:puuid(/:tab)` all return the shell (History API routing, old `#/` links are rewritten client side) |

## Data Flow: Add Riot Account
1. `add/start`: makes `flowId`, PKCE pair. Saves `pkce:add:<flowId>` (15 min) with verifier and `discordId`. Returns a Riot authorize URL (`client_id=ritoplus`, `redirect_uri=http://localhost/redirect`).
2. User signs in at Riot, lands on a dead localhost URL, pastes the full URL back.
3. `add/complete`: checks flow owner = session user. `riot.parseRedirectFragment` pulls `code`. `riot.exchangeDpopCode` gets tokens. `linkAccount` saves the row. Then a warm `shop.getShop` call fills the store cache.
4. `linkAccount`: identity comes from fresh tokens only (`playerFromTokens`, falls back to `playerSession`). Keeps the old refresh token if Riot returned none. First account of a user becomes `is_default`.

## Sharing Model
- Share code = bearer capability for one Riot account, read-only.
- Stored only as HMAC digest (`storage.hashShareCode`). DB dump leaks no usable code.
- Recipient never gets the owner's tokens. Shared shops are fetched with the owner's stored session (`shopFor`, `accountAccessFor`).

## State Invariants
- `/api/interactions` must stay before the global JSON parser skip logic and must use `express.raw`. Parsing it breaks signature checks.
- `rateLimit()` uses an in-memory `Map`. Best effort per serverless instance only. `rateLimitShared()` holds across instances (kv key `rl:<scope>`, throws 429).
- Grid image routes accept either `LINK_SECRET` (query `secret` or header `x-link-secret`) or a session user who owns the account.
- Error handler at the bottom maps `err.status` to the response. `httpError(msg, status)` builds those errors.

## Dependencies & Contracts
- Internal: `src/riot`, `src/items`, `src/storage`, `src/shop`, `src/session`, `src/parse`, `src/grid`, `src/discord/*`.
- External: `express`, `express-session`, `@vercel/functions` (`waitUntil`).
- Callers: `server.js` (local) and `api/index.js` (Vercel).
