---
id: arch-store-parser
type: architecture
title: Store Parser
target_files:
  - src/parse.js
tags: [parse, storefront, data-model]
updated: 2026-10-26
---

# Architecture: Store Parser

## Target Files & Scope
- `src/parse.js`: Pure function layer. Turns raw Riot storefront + wallet JSON into the app's store model. No network.

## Public API
- `buildStoreResponse(storefront, wallet, now = Date.now())`
- `dedupeBundles(list)`

## Output Model (cached as `accounts.store_cache`)
```
{
  wallet: { vp, kc, rp },                      // null when unknown
  daily: { expiresAt, items: [{...item, price, currency:'vp'}] },
  nightMarket: null | { expiresAt, items: [{...item, price, basePrice, discount, currency:'vp'}] },
  kingdomShop: null | { expiresAt, items: [{...item, price, currency:'kc'}] },
  bundles: [bundleEntry]                       // deduped, only leavesAt > now
}
```
Items are spread from `items.resolve(rewardItem(offer))`.

## Source Mapping
- `daily` <- `SkinsPanelLayout.SingleItemStoreOffers`, expiry from `SingleItemOffersRemainingDurationInSeconds`.
- `nightMarket` <- `BonusStore.BonusStoreOffers` (`DiscountCosts`, `DiscountPercent`).
- `kingdomShop` <- `AccessoryStore.AccessoryStoreOffers`, price in KC.
- `bundles` <- `FeaturedBundle.Bundle` + `FeaturedBundle.Bundles`.

## State Invariants
- `expiresAt` values are absolute ms, computed from `now`. Crons compare them to detect a new rotation, so keep them absolute.
- Shape changes break cached rows until they expire (45 min) and break Discord embeds and grid renderers. Update [image-rendering](image-rendering.md) and [discord-bot](discord-bot.md) together.

## Dependencies & Contracts
- Internal: `src/items.js` (`CURRENCY`, `resolve`).
- Callers: `src/shop.js`, `src/discord/commands.js` (`dedupeBundles`), `app.js`.
