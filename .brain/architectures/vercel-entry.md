---
id: arch-vercel-entry
type: architecture
title: Vercel Entry (api/)
target_files:
  - api/index.js
  - vercel.json
  - .vercelignore
tags: [vercel, serverless, deploy]
updated: 2026-10-26
---

# Architecture: Vercel Entry (api/)

## Target Files & Scope
- `api/index.js`: 3 lines. `module.exports = require('../app')`. The whole Express app runs as one Vercel function.
- `vercel.json`: rewrites every path `/(.*)` to `/api/index`. Sets `maxDuration: 60` for `api/index.js`. Declares two crons.
- `.vercelignore`: excludes `.env*`, `nul.js`, `*.bak`, `.opencode`, `node_modules`.

## Data Flow
- Request -> Vercel edge -> rewrite to `/api/index` -> Express `app` in `app.js` -> route.
- The original path survives the rewrite, so Express routing sees the real URL.

## Crons (vercel.json)
| Path | Schedule (UTC) |
| :--- | :--- |
| `/api/cron/refresh` | `0 5 * * *` |
| `/api/cron/dailyshop` | `30 0 * * *` |

`/api/cron/bundles` is NOT in `vercel.json`. It is driven by an external scheduler that sends `SCHEDULER_SECRET`. See [cron-jobs](cron-jobs.md).

## State Invariants
- Serverless: many instances, no shared memory. In-memory caches and locks in `app.js` and `src/shop.js` are per instance only.
- Work after the HTTP response must go through `waitUntil` (`@vercel/functions`) or it can be frozen.
- 60 s max per invocation. All Riot calls go through `fetchWithTimeout` to stay inside it.

## Dependencies & Contracts
- Internal: `app.js` ([app-http-server](app-http-server.md)).
- External: Vercel runtime, Node >= 20 (`package.json` engines).
