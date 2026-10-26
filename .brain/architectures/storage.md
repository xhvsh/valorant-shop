---
id: arch-storage
type: architecture
title: Storage Layer
target_files:
  - src/storage.js
  - src/session.js
tags: [storage, supabase, encryption, kv, session]
updated: 2026-10-26
---

# Architecture: Storage Layer

## Target Files & Scope
- `src/storage.js`: All persistence. Supabase client when `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are set, else in-memory `mem` maps (local dev). Also owns AES-256-GCM `encrypt`/`decrypt` and share-code HMAC.
- `src/session.js`: `PackageStore`, an `express-session` Store that maps `get/set/destroy/touch` onto `storage.session*`.

Schema: [database-schema](database-schema.md).

## Public API
- Crypto: `encrypt(obj)`, `decrypt(str)`, `hashShareCode(code)`. Key from `ENCRYPTION_KEY` (64 hex chars used raw, else SHA-256 of the string). Missing key throws.
- Sessions: `sessionGet`, `sessionSet(sid, data, maxAgeMs)`, `sessionDestroy`.
- KV: `kvSet(key, value, ttlMs)`, `kvGet`, `kvDel`, `kvList(prefix)` (pages of 1000, skips expired).
- Accounts: `getAccount(discordId, puuid?)` (no puuid = default account), `listAccountsByUser` (default first, then oldest), `saveAccount` (upsert on `discord_id,puuid`), `deleteAccount(discordId, puuid?)` (no puuid = all rows), `listAccounts`, `getStats`.
- Prefs: `getPrefs`/`setPrefs`. Wishlist: `getWishlist`/`setWishlist`. Shares: `getShare`/`putShare`/`delShare`, `getOwnerShares`/`putOwnerShares`, `getImportedShares`/`putImportedShares`.
- `isConfigured()` = Supabase present.

## KV Key Registry
| Key | Owner | TTL | Value |
| :--- | :--- | :--- | :--- |
| `alertprefs:<discordId>` | storage | 365 d | `{ accounts: { [puuid]: {shop, accessory, wishlist_shop, wishlist_accessory} }, nm, bundle, order }` |
| `wishlist:<discordId>` | storage | 365 d | `{ daily: WishItem[], accessory: WishItem[] }` |
| `share:code:<hmac>` | storage | ~10 y | share record |
| `share:owner:<discordId>` | storage | ~10 y | `{ items: { [puuid]: {code, name, shard, created_at} } }` |
| `share:user:<discordId>` | storage | ~10 y | `{ items: { [puuid]: {code, owner_id, owner_name, name, shard, added_at} } }` |
| `dpop:key`, `dpop:nonce` | riot.js | 365 d (sliding) | DPoP keypair, last server nonce |
| `pkce:add:<flowId>` | app.js | 15 min | `{ verifier, discordId }` |
| `shop_reset:<discordId>:<puuid>` | shop.js | 25 h | `{ at }` next daily rotation |
| `dailyshop_sent:<discordId>:<puuid>` | app.js cron | marker | last sent daily rotation |
| `accshop_sent:<discordId>:<puuid>` | app.js cron | marker | last sent accessory rotation |
| `dailyshop:<discordId>` | legacy | | retired subscription, imported once by `loadPrefsWithLegacy` |
| `bundle_seen` (`BUNDLE_SEEN_KEY`) | app.js cron | 60 d | `{ ids: {bundleId: ts}, at }` |
| `rl:<scope>` | app.js `rateLimitShared` | window + 1 s | array of hit timestamps |

## State Invariants
- Prefs alert shape migrates on read: legacy `wishlist` flag splits into `wishlist_shop` + `wishlist_accessory` (`normalizeAlert`). Keep that fallback.
- `setWishlist` merges: an omitted list keeps the previous value.
- DB errors go through `dbFail`, which throws status 503.
- In-memory fallback mirrors Supabase semantics, including expiry checks on read.

## Dependencies & Contracts
- Callers: `app.js`, `src/shop.js`, `src/riot.js` (passed in as `store` for DPoP state), `src/session.js`.
- External: `@supabase/supabase-js`, `node:crypto`.
