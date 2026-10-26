# Brain Index

Project: val shops. Express app (Vercel serverless) plus Discord bot. Shows a user's VALORANT daily shop, Night Market, accessory (KC) store, bundles, rank, and collection. Users sign in with Discord, link Riot accounts through a pasted-URL DPoP flow, and get daily DM alerts.

Request path: `api/index.js` (Vercel) or `server.js` (local) -> `app.js` -> `src/shop.js` -> `src/riot.js` + `src/storage.js` -> `src/parse.js` -> `src/grid.js` / `src/discord/embeds.js`.

| Type | Title | Path | Target Files | Updated |
| :--- | :--- | :--- | :--- | :--- |
| Architecture | App HTTP Server | `architectures/app-http-server.md` | `app.js`, `website/index.html`, `website/dashboard.js` | 2026-10-26 |
| Architecture | Vercel Entry | `architectures/vercel-entry.md` | `api/index.js`, `vercel.json`, `.vercelignore` | 2026-10-26 |
| Architecture | Local Server | `architectures/local-server.md` | `server.js`, `package.json`, `.env.example` | 2026-10-26 |
| Architecture | Database Schema | `architectures/database-schema.md` | `schema.sql`, `src/storage.js` | 2026-10-26 |
| Architecture | Storage Layer | `architectures/storage.md` | `src/storage.js`, `src/session.js` | 2026-10-26 |
| Architecture | Riot API Client | `architectures/riot-client.md` | `src/riot.js` | 2026-10-26 |
| Architecture | Shop Service | `architectures/shop-service.md` | `src/shop.js` | 2026-10-26 |
| Architecture | Item Catalog | `architectures/item-catalog.md` | `src/items.js`, `src/skin-collections.json`, `src/bp-accessories.json` | 2026-10-26 |
| Architecture | Store Parser | `architectures/store-parser.md` | `src/parse.js` | 2026-10-26 |
| Architecture | Image Rendering | `architectures/image-rendering.md` | `src/grid.js`, `src/image-color.js`, `assets/*.ttf` | 2026-10-26 |
| Architecture | Discord Bot | `architectures/discord-bot.md` | `src/discord/*.js`, `app.js`, `scripts/register-commands.js` | 2026-10-26 |
| Architecture | Cron Jobs | `architectures/cron-jobs.md` | `app.js`, `vercel.json` | 2026-10-26 |
| Architecture | Dev Test Scripts | `architectures/dev-fixtures.md` | `scripts/test-*.js` | 2026-10-26 |
| Decision | Remove Mock Mode and Test Night Market | `decisions/remove-mock-mode.md` | `app.js`, `server.js`, `package.json`, `.env.example` | 2026-10-26 |

## Open Observations (not yet faults or decisions)
- `/api/cron/bundles` timing depends entirely on the external scheduler; bundles are only seen as fast as it polls.
