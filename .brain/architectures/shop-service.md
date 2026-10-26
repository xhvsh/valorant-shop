---
id: arch-shop-service
type: architecture
title: Shop Service
target_files:
  - src/shop.js
tags: [shop, cache, tokens, riot]
updated: 2026-10-26
---

# Architecture: Shop Service

## Target Files & Scope
- `src/shop.js`: Business layer between routes and Riot. Token renewal, store fetch + cache, account details (rank, collection, loadout), bundle memory.

## Public API
- `getShop(discordId, puuid?, { force })` -> `{ status: 'unlinked'|'ok'|'relink'|'error', store?, account?, cached?, error? }`. No puuid = default account.
- `cachedStoreFor(discordId, puuid, account?)`: cache-only fast path for Discord. Never calls Riot.
- `accountDetails(discordId, puuid)`: rank (`summarizeRank`), owned skins/accessories, equipped loadout.
- `renewTokens(auth, opts)`: used by `/api/cron/refresh` too.
- `rememberBundles`, `latestBundles`, `anyCachedBundles`. `STORE_TTL`.

## Data Flow: getShop
1. `storage.getAccount`. None -> `unlinked`.
2. Cache check (`cachedStore`): `store_cache` valid when younger than `STORE_TTL` (45 min) AND before reset instant (`shop_reset:<discordId>:<puuid>`, legacy `shop_reset:<discordId>`). Hit -> `freshStore` re-resolves icons from the live catalog.
3. `storage.decrypt(auth_encrypted)`. Failure -> `relink`.
4. `ensureAccessToken`: reuse token if more than 60 s from expiry, else `lockedRefresh` -> `renewTokens` -> persist new encrypted auth.
5. `items.load()` (stale catalog OK on failure). `entitlementFor` (cached 50 min per access token).
6. `storefront` + `wallet` in parallel. Wallet failure is tolerated. Storefront 400 about version -> `resetClientVersion` and retry once.
7. `buildStoreResponse` ([store-parser](store-parser.md)). Reset instant = now + `SingleItemOffersRemainingDurationInSeconds`, else next UTC midnight.
8. Save `shop_reset` key (25 h) and `store_cache`.

## Error Taxonomy
- `REVOKED`: refresh grant dead (`invalid_grant` on 400/401/403). Mapped to `RELINK` -> status `relink`.
- `TRANSIENT`: refresh failed after retries (2 retries, 500 ms backoff). Never flips the account to relink.
- Entitlement 401 -> `RELINK`.

## State Invariants
- Only `invalid_grant` means re-link. Rate limits, timeouts, outages must stay transient.
- Refresh tokens rotate, so a double spend poisons the account. `refreshLocks` single-flights per process. Across serverless instances `refreshAcrossInstances` takes a `refresh_lock:<discordId>:<puuid>` row in `kv` (`storage.kvLock`, insert-only, 30 s TTL). Losers poll the stored auth and reuse the winner's tokens (12 s wait, then TRANSIENT). Tokens are persisted before the lock is released. `shop.refreshTokens` exports this for the cron.
- `ensureAccessToken` mutates the passed `auth` object in place before persisting.

## Dependencies & Contracts
- Internal: `src/riot.js`, `src/storage.js`, `src/items.js`, `src/parse.js`.
- Callers: `app.js` routes, Discord follow-up, crons.
