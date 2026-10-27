---
id: arch-item-catalog
type: architecture
title: Item Catalog
target_files:
  - src/items.js
  - src/skin-collections.json
  - src/bp-accessories.json
tags: [catalog, valorant-api, wishlist]
updated: 2026-10-26
---

# Architecture: Item Catalog

## Target Files & Scope
- `src/items.js`: In-memory catalog of VALORANT cosmetics from `https://valorant-api.com`. Resolves Riot item UUIDs to name, icon, art, tier, type. Powers wishlist search and store-eligibility filtering.
- `src/skin-collections.json`: `storeCollections`, `excludedCollections`, `excludedSkins`. Generated from community wiki Store and Battle Pass templates. Regenerate each act.
- `src/bp-accessories.json`: Battle pass accessory list (not store-eligible).

## Data Flow
- `load(force)`: fetches `SOURCES` in parallel: `/v1/weapons/skins`, `/v1/buddies`, `/v1/sprays`, `/v1/playercards`, `/v1/flex`, `/v1/playertitles`, `/v1/bundles`. Plus `/v1/weapons` to tag each skin with weapon + category.
- Cache `TTL` = 12 h. Concurrent callers share one `loading` promise.
- Partial failure merges into the stale copy. Total failure keeps the stale copy. Throws only with no catalog at all.
- Also loads contracts (`loadContracts`) and competitive tiers (`loadTiers`).

## Public API
- Lookup: `resolve(id)`, `details(id)`, `byType`, `kindOf`, `skinKind`, `refreshIcons(store)`.
- Search: `search(query, kind, limit=30)`, `storeIndex()`, `skinBuckets()`.
- Eligibility: `isStoreEligible(entry)`, `isStoreEligibleId(id)`.
- Ranks: `competitiveTiers()`, `rankTier(n)`, `tierIcon(name)`.
- Money: `CURRENCY` (vp, kc, agentTokens, rp UUIDs), `CURRENCY_LABEL`, `currencies()`.
- `normalizeName`.

## State Invariants
- Skin eligibility also excludes every skin named in Riot's contracts (battle pass and agent sets, loaded by `loadContracts`), so a new act's pass is hidden before `skin-collections.json` is regenerated. 2026-10-27 audit: 699 eligible skins, none in a pass or agent contract; the 121 eligible collections match `storeCollections`.
- `bp-accessories.json` is the accessory whitelist: battle pass accessories (not Epilogue, not Coin collection) from passes older than the 3 newest. It goes stale one act at a time on the safe side (items hidden, never wrongly shown); add the newly aged-out act each time. Updated 2026-10-27 with Season 2026 Act I to III.
- `storeIndex()` also carries skin facets for the wishlist filters: `w` weapon, `g` category, `e` tier, `k` collection (Riot theme name, else the name minus its weapon). `load()` fetches `/v1/themes` for that.
- Collection matching uses the LONGEST known prefix (store "Celestial" vs pass "Celestia", "Prism II" vs "Prism III"). Keep that rule when editing.
- Unknown collections count as eligible. Wrongly hiding an item is worse than showing one.
- `items.js` requires `./riot` for `fetchWithTimeout`. `riot.js` must never require `items.js` (cycle).

## Dependencies & Contracts
- Callers: `src/shop.js`, `src/parse.js`, `src/grid.js`, `src/discord/embeds.js`, `app.js`.
- External: valorant-api.com (unofficial community API).
