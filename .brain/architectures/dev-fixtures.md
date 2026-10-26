---
id: arch-dev-fixtures
type: architecture
title: Dev Test Scripts
target_files:
  - scripts/test-inventory.js
  - scripts/test-inventory-probe.js
  - scripts/test-loadout-paths.js
tags: [dev, testing]
updated: 2026-10-26
---

# Architecture: Dev Test Scripts

## Target Files & Scope
- `scripts/test-inventory.js`, `scripts/test-inventory-probe.js`, `scripts/test-loadout-paths.js`: Manual probes against Riot inventory and loadout endpoints.
- `src/mock.js` and `src/test-night-market.js` were removed on 2026-10-26. See [remove-mock-mode](../decisions/remove-mock-mode.md).

## State Invariants
- No automated test suite exists. `npm run lint` is syntax only (`node --check` per file).
- No demo or mock mode exists. Local dashboard work needs a real linked Riot account.

## Dependencies & Contracts
- Internal: `src/riot.js`, `src/storage.js`, `src/shop.js` as used by each script.
