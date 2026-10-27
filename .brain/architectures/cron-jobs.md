---
id: arch-cron-jobs
type: architecture
title: Cron Jobs
target_files:
  - app.js
  - vercel.json
tags: [cron, alerts, dm, scheduler]
updated: 2026-10-26
---

# Architecture: Cron Jobs

## Target Files & Scope
- `app.js` (Cron section): `cronAuthorized`, `/api/cron/refresh`, `/api/cron/dailyshop`, `/api/cron/bundles`, `runBundleCheck`, `loadPrefsWithLegacy`, `wishlistMatches`, `wishlistMatchItems`, `nightMarketWishlistText`, `sameRotation`.
- `vercel.json`: schedules for refresh and dailyshop.

## Auth (`cronAuthorized`)
Any one of:
- `?secret=` or `Authorization: Bearer` equal to `CRON_SECRET` (falls back to `LINK_SECRET`).
- Header `x-link-secret` equal to `LINK_SECRET`.
- Header `x-scheduler-secret` or `?key=` equal to `SCHEDULER_SECRET` (external exact-time scheduler).

## Jobs
| Route | Trigger | Job |
| :--- | :--- | :--- |
| `/api/cron/refresh` | Vercel `0 5 * * *` | For every account: skip if token valid more than 15 min. No refresh token -> count as relink. Else `shop.renewTokens` and persist. Owners of dead accounts get a re-link notice at most once per 7 days. |
| `/api/cron/dailyshop` | Vercel `0 0 * * *` (fallback) and an external scheduler with `SCHEDULER_SECRET` (set it to 00:00:05 UTC) | Collect user IDs from `alertprefs:`, legacy `dailyshop:`, `wishlist:` keys. Per user: `getShop` for every account, then send DM for accounts with `shop`/`accessory` toggles when the rotation is new. Also night market and wishlist hit alerts. |
| `/api/cron/bundles` | External scheduler | `runBundleCheck`: compare live bundles from `BUNDLE_SOURCE_ID` to `BUNDLE_SEEN_KEY`. New bundle -> alert users with `prefs.bundle`. |

## State Invariants
- Dedup markers: `dailyshop_sent:<discordId>:<puuid>` and `accshop_sent:<discordId>:<puuid>`. `sameRotation(marker, rotAt)` decides if already sent. Keep markers keyed per account.
- `runBundleCheck` persists the seen map BEFORE sending, so overlapping runs cannot double-send. First run seeds silently with no alerts.
- Seen bundle ids are retained for `BUNDLE_SEEN_RETENTION_MS` (2 days), so a short blip does not re-alert.
- dailyshop runs users in a pool of `DAILY_CONCURRENCY` (8) and each user's accounts in parallel. A store with under `ROTATION_GRACE_MS` (2 min) left is the previous rotation: the job polls (`forced` refetch every 8 s, 35 s budget shared by the run) and otherwise skips without writing a marker, so the next trigger retries. This lets the trigger fire at 00:00 without DMing yesterday's shop.

## Dependencies & Contracts
- Internal: `src/shop.js`, `src/storage.js`, `src/discord/embeds.js`, `src/discord/log.js`, `src/grid.js`.
- Related: [discord-bot](discord-bot.md), [vercel-entry](vercel-entry.md).

## Night Market wishlist alert
- Global prefs `wishlist_nm` (on/off) and `nm_names` (show item names, default off = spoiler free). Handled in `/api/cron/dailyshop` after the Night Market alert: one DM across accounts when a wishlisted skin is in an account's Night Market.
- Spoiler free text says "an item from your wishlist" (or "items") per account; with names it lists each skin and its discount.
- Marker `wishlist_nm_notify:<discordId>:<puuid>` holds `{ at: nm.expiresAt, ids }`, so each Night Market alerts once per account and a later wishlist addition still alerts.
