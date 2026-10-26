---
id: decision-remove-mock-mode
type: decision
title: Remove Mock Mode and Test Night Market
target_files:
  - app.js
  - server.js
  - package.json
  - .env.example
tags: [cleanup, dev, mock]
updated: 2026-10-26
---

# Decision: Remove Mock Mode and Test Night Market

## Context
- `src/mock.js` built a fake store from the real catalog for a demo mode.
- `src/test-night-market.js` was a TEMPORARY helper that injected a synthetic Night Market for accounts named in `TEST_NIGHT_MARKET`.
- On 2026-10-26 no file required either module. `MOCK_MODE` was still parsed in `app.js` and `server.js`, but it only fed the `/health` JSON (`mock` field) and a boot log line that pointed at a `/auth/mock` route which no longer exists.

## Decision
Delete both modules and every `MOCK_MODE` leftover.

## Changes Applied
- Deleted `src/mock.js` and `src/test-night-market.js`.
- `package.json`: dropped both files from the `lint` script.
- `app.js`: removed the `MOCK_MODE` constant. `/health` now returns `{ ok, storage }` (the `mock` field is gone).
- `server.js`: removed the `MOCK_MODE` constant and the "Demo mode" log line.
- `.env.example`: removed the Demo section (`MOCK_MODE=true`).
- Local `.env` (gitignored, not tracked here): removed the `MOCK_MODE=true` line and renamed the section header to Website.

Verified: `npm run lint` passes, no `MOCK_MODE` / `mock.js` / `test-night-market` / `auth/mock` references remain outside `.brain/`, `require('./app')` loads.

## Rejected Alternatives
- Re-wire `applyTestNightMarket` into `/api/shop`: rejected. It was a temporary visual check for Night Market styling, and it carried a prod risk (real users seeing a fake Night Market if `TEST_NIGHT_MARKET` stayed set).
- Keep `src/mock.js` for a future demo mode: rejected. Dead code, and a demo would need a new route and fixture design anyway.

## Consequences
- No offline or demo mode. Local dashboard work needs a real linked Riot account.
- Anything that reads `/health` and expects `mock` gets `undefined`. No consumer was found in the repo.
- `MOCK_MODE` or `TEST_NIGHT_MARKET` may still be set in the Vercel project env. They are now ignored and can be removed there.
- Recovery: copies of the deleted files were saved to the session scratchpad (`removed-2026-10-26/`). That copy is temporary. The project has no git history.
