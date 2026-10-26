---
id: arch-local-server
type: architecture
title: Local Server (server.js)
target_files:
  - server.js
  - package.json
  - .env.example
tags: [dev, node, entrypoint]
updated: 2026-10-26
---

# Architecture: Local Server (server.js)

## Target Files & Scope
- `server.js`: Local entry. Requires `./app`, calls `app.listen(PORT)`. Logs base URL and Riot OAuth status.
- `package.json`: `npm start` = `node server.js`. `npm run dev` = `node --watch server.js`. `npm run lint` = `node --check` over every JS file (no real linter, syntax only).
- `.env.example`: Template for local env. Safe to read. Never copy values from `.env` or `.env.local` into notes.

## Data Flow
- `node server.js` -> `require('./app')` (loads `.env`, builds Express app) -> `listen(PORT)`.
- Without Supabase env, `src/storage.js` falls back to in-memory maps. Data dies on restart.

## Env Read Here
- `PORT` (default 3000), `BASE_URL`, `RIOT_CLIENT_ID`, `RIOT_CLIENT_SECRET`.
- Note: the `RIOT_CLIENT_ID`/`SECRET` log line is legacy. Current sign-in uses the `ritoplus` DPoP flow in `src/riot.js`, which needs neither. `MOCK_MODE` was removed on 2026-10-26 (see [remove-mock-mode](../decisions/remove-mock-mode.md)).

## State Invariants
- `app.js` throws at require time without `SESSION_SECRET` and `LINK_SECRET`. Local runs need both in `.env`.
- `npm run lint` lists files by hand. A new JS file must be added to the script or it is never checked.

## Dependencies & Contracts
- Internal: `app.js` ([app-http-server](app-http-server.md)).
- Prod path does not use this file. See [vercel-entry](vercel-entry.md).
