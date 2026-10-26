---
id: arch-riot-client
type: architecture
title: Riot API Client
target_files:
  - src/riot.js
tags: [riot, oauth, dpop, http]
updated: 2026-10-26
---

# Architecture: Riot API Client

## Target Files & Scope
- `src/riot.js`: Every outbound call to Riot. Auth (DPoP + PKCE token flow), entitlements, geo, and the `pd.<shard>.a.pvp.net` player-data endpoints. Also exports `fetchWithTimeout` used across the codebase.

## Auth Flow (current)
- Client `ritoplus`, redirect `http://localhost/redirect`, scopes include `offline_access` so a refresh token is issued.
- `generatePkce()` -> authorize URL built in `app.js` -> user pastes redirect URL -> `parseRedirectFragment` -> `exchangeDpopCode(store, code, verifier)`.
- `refreshDpop(store, refreshToken)` renews. Refresh tokens rotate.
- DPoP: one app-wide keypair in kv `dpop:key` (`getDpopKey`), last nonce in `dpop:nonce`. `createDpopProof` signs each request.
- `dpopTokenRequest` and `dpopFetch` retry once when Riot rejects the nonce and sends a fresh `DPoP-Nonce` header (`isNonceError`). Any other 4xx fails at once.
- Token POST uses raw `https` (`httpsPost`), not fetch.

Legacy exports still present: `authorizeUrl`, `getPasteAuthUrl`, `exchangeCode`, `refreshToken` (client-secret OAuth). Not on the main path.

## Player Data
- `pdFetch(url, tokens)`: headers `Authorization: Bearer`, `X-Riot-Entitlements-JWT`, `X-Riot-ClientPlatform` (fixed base64 blob), `X-Riot-ClientVersion`.
- `clientVersion()`: from `https://valorant-api.com/v1/version`, cached 1 h. `resetClientVersion()` clears it (shop.js calls it on a 400 mentioning version).
- `storefront()`: POST v3 first. On 404/405/422 falls back to GET v2. If v3 lacks `BonusStore`, `AccessoryStore`, `SkinsPanelLayout`, or `FeaturedBundle`, fills those from v2.
- Also: `wallet`, `mmr`, `accountXp`, `accountEntitlements`, `playerLoadout` (unofficial personalization v2), `revealNightMarket`.
- Identity: `userinfo`, `entitlements`, `geo` -> `playerSession` (puuid, name, shard). `playerFromTokens` decodes JWTs locally without network.
- `SHARDS = ['na','eu','ap','kr','pbe']`, `regionToShard`.

## State Invariants
- Every network call must go through `fetchWithTimeout` (15 s default). A hung Riot endpoint otherwise eats the 60 s serverless budget.
- The DPoP key is shared by all accounts. Rotating or deleting `dpop:key` invalidates every DPoP-bound refresh token, so every user must re-link.
- Error objects carry `.status` (and `.riotBody` from pdFetch). Callers branch on it.

## Dependencies & Contracts
- Callers: `src/shop.js`, `app.js` (add-account), `src/items.js` (`fetchWithTimeout`).
- `store` argument = `src/storage.js` module (needs `kvGet`/`kvSet`).
- External: `node:crypto`, `node:https`, Riot auth/pd hosts, valorant-api.com.
