---
id: arch-image-rendering
type: architecture
title: Image Rendering
target_files:
  - src/grid.js
  - src/image-color.js
  - assets/DejaVuSans.ttf
  - assets/Anton-Regular.ttf
  - assets/RankMono.ttf
tags: [images, svg, resvg, gif, discord]
updated: 2026-10-26
---

# Architecture: Image Rendering

## Target Files & Scope
- `src/grid.js` (~1340 lines): Builds SVG, rasterizes with `@resvg/resvg-js` to PNG. Animated GIF variant decodes source GIFs (`omggif`) and re-encodes (`gifenc`).
- `src/image-color.js`: Dependency-free PNG decoder (zlib + Paeth) and dominant-color picker. Used for Discord embed accent colors.

## Public API (grid.js)
- `renderSkinGrid(store, opts)`: daily shop or accessory grid (`opts.items`, `limit`, `showType`).
- `renderAnimatedSkinGrid(store, opts)`: GIF grid for animated icons.
- `renderWalletImage(wallet)`, `renderBundleGrid(items)`, `renderRankImage(rank, opts)`, `renderCollectionImage(columns)`, `renderInventoryImage(details, opts)`, `renderOwnedGrid(opts)`.
- `shortNum`, `GRID_CACHE_VERSION`.

## Public API (image-color.js)
- `dominantColor(url, { timeoutMs = 8000 })`, `decodePng`, `dominantFromRgba`.

## Layout Constants
- Cell `560x320`, gap 18. Normal shop and accessory cells use `cardCell` (mirrors the website `.card`: media area `CARD_MEDIA_H` 196 with tier glow, name, price left, type or tier right). Night Market (`discount: true`) and bundles use the same cell, with a struck old price and a -N% badge for discounts. Currency icons from `media.valorant-api.com`. Discord custom emoji IDs for vp/kc/rp in `EMOJI_IDS`.
- Animated grid: frames after the first carry only changed pixels (disposal 1), tick = smallest source frame delay, up to `GIF_MAX_FRAMES` (150) so a spray never restarts mid-cycle, coarser tick if over `GIF_MAX_BYTES`.

## State Invariants
- Rendering runs with system fonts off. Fonts must come from `assets/` (`DejaVuSans.ttf`, `Anton-Regular.ttf` for rank card, `RankMono.ttf` for RR readout). A new glyph or font needs a bundled file.
- Remote icons are fetched and inlined as data URIs (`fetchIconData`, `cachedIcon`). Keep fetches bounded by timeouts.
- `GRID_CACHE_VERSION` (currently `'6'`) is exported but no other file reads it as of 2026-10-26. Bumping it alone does not bust any cache. Grid routes send `Cache-Control: max-age=1800`.

## Dependencies & Contracts
- Internal: `src/items.js`.
- Callers: `app.js` (`/api/skin-grid`, `/api/bundle-grid`, Discord follow-up, daily DM), `src/discord/commands.js`, `src/discord/embeds.js` (via image-color).
- External: `@resvg/resvg-js`, `omggif`, `gifenc`.
