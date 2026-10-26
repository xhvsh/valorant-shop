---
id: arch-discord-bot
type: architecture
title: Discord Bot
target_files:
  - src/discord/commands.js
  - src/discord/embeds.js
  - src/discord/log.js
  - src/discord/verify.js
  - app.js
  - scripts/register-commands.js
tags: [discord, interactions, bot]
updated: 2026-10-26
---

# Architecture: Discord Bot

## Target Files & Scope
- `src/discord/verify.js`: `verifyRequest(publicKey, signature, timestamp, rawBody)` with `tweetnacl` Ed25519.
- `src/discord/commands.js`: `COMMANDS` definitions, `handleInteraction` (first response), `accountChoices` (autocomplete), `bundlePayload`, `BUNDLE_SOURCE_ID`.
- `src/discord/embeds.js`: Components V2 message builders (`buildShopMessage`, `buildAccessoryMessage`, `buildNightMarketMessage`, `buildBundleMessage`, `buildRankMessage`, `buildCollectionMessage`, footers, `fmtLeft`).
- `src/discord/log.js`: `sendLog` to an admin log channel (`LOG_CHANNEL_ID`, env with hard-coded fallback), `adminMention`, `userMention`, `resolveName`.
- `app.js`: `POST /api/interactions`, `POST /api/interactions/followup`, `renderShopMessage`, `renderDailyDm`, `sendDirectMessage`.
- `scripts/register-commands.js`: Registers `COMMANDS` with Discord.

## Commands
`/shop`, `/accessories`, `/nightmarket`, `/rank`, `/collection` (all take optional `account` with autocomplete), `/bundle` (no account, data from `BUNDLE_SOURCE_ID`), `/link` (ephemeral link to the dashboard), `/share code|import|stop` and `/main account` (deferred ephemerally; logic shared with the dashboard via `createShareFor`, `importShareFor`, `revokeShareFor`, `setMainAccount` in `app.js`). The account picker follows the dashboard order (`prefs.order`); `share` and `main` list own accounts only.

## Data Flow: Slash Command
1. Discord POSTs `/api/interactions`. Body read with `express.raw`. Signature checked against `DISCORD_PUBLIC_KEY`.
2. `type 1` PING -> `{type:1}`. `type 4` autocomplete -> `accountChoices`.
3. `type 2` command -> `handleInteraction`. Data commands return `type 5` (deferred, public).
4. On defer, `fireFollowUp` POSTs to `${APP_URL}/api/interactions/followup` with header `x-link-secret`, wrapped in `waitUntil`. This starts a fresh invocation with its own time budget.
5. Follow-up checks `LINK_SECRET`, runs the slow work (`shop.getShop`, renders via [image-rendering](image-rendering.md)), then edits `webhooks/<DISCORD_CLIENT_ID>/<token>/messages/@original`.
6. `type 3` components: `bundle_select` and legacy `bundle_view:*` re-render through follow-up, reply `type 6`.

## State Invariants
- Discord needs a reply within 3 s. Anything that can call Riot must go through defer + follow-up.
- Follow-up endpoint trusts only `x-link-secret === LINK_SECRET`.
- Bundle data comes from one hard-coded account (`BUNDLE_SOURCE_ID`). If that account needs re-link, `/bundle`, `/api/bundle-grid`, and bundle alerts break for everyone.
- After changing `COMMANDS`, run `scripts/register-commands.js` or Discord keeps the old definitions.

## Dependencies & Contracts
- Internal: `src/shop.js`, `src/storage.js`, `src/grid.js`, `src/parse.js`, `src/items.js`, `src/image-color.js`.
- External: Discord API v10, `tweetnacl`. Env: `DISCORD_PUBLIC_KEY`, `DISCORD_CLIENT_ID`, `DISCORD_BOT_TOKEN`, `LINK_SECRET`, `APP_URL`.
