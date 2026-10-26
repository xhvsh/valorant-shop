---
id: arch-database-schema
type: architecture
title: Database Schema (schema.sql)
target_files:
  - schema.sql
  - src/storage.js
tags: [supabase, postgres, schema, security]
updated: 2026-10-26
---

# Architecture: Database Schema (schema.sql)

## Target Files & Scope
- `schema.sql`: Supabase Postgres schema. Run by hand in the Supabase SQL editor. Idempotent, safe to re-run.
- `src/storage.js`: The only code that talks to these tables. See [storage](storage.md).

## Tables
| Table | Key | Columns | Purpose |
| :--- | :--- | :--- | :--- |
| `accounts` | PK `(discord_id, puuid)` | `name`, `label`, `shard`, `is_default`, `auth_encrypted`, `store_cache` jsonb, `store_updated_at`, `created_at`, `updated_at` | One row per (Discord user, Riot account) link. |
| `sessions` | `sid` | `data` jsonb, `expires_at` | express-session store. |
| `kv` | `key` | `value` text (JSON string), `expires_at` | Generic TTL key-value store. Prefs, wishlist, shares, DPoP key, locks, markers. |

Indexes: `sessions_expires_at_idx`, `kv_expires_at_idx`.

## Migrations Baked In
- Multi-account: adds `label`, `is_default`, `created_at`. Backfills `is_default=true` for users with one row. Swaps PK from `discord_id` to `(discord_id, puuid)`.
- PK swap is skipped with a notice while any row has `puuid IS NULL`. Those users must re-link, then re-run.
- Drops any leftover UNIQUE on `puuid` alone. One Riot account may be linked by many Discord users.
- Drops retired `link_codes` table (old code-based `/link` flow).

## Housekeeping
- `cleanup_expired()` deletes expired `sessions` and `kv` rows. Schedule with pg_cron, or rely on delete-on-read in `storage.js`.

## Access Control
- RLS enabled on all three tables, no policies. `anon` and `authenticated` get all privileges revoked.
- Only `service_role` has access. The app uses `SUPABASE_SERVICE_ROLE_KEY`, which bypasses RLS.

## State Invariants
- `auth_encrypted` holds AES-256-GCM ciphertext of Riot tokens (`iv:tag:data`, base64). Losing or changing `ENCRYPTION_KEY` makes every row undecryptable, so every user must re-link.
- `kv.value` is a JSON string. `kvGet` parses it, raw string kept on parse failure.
- Never grant `anon`/`authenticated` on these tables. They hold tokens and sessions.

## Dependencies & Contracts
- Internal callers: `src/storage.js` only.
- External: Supabase (`@supabase/supabase-js`).
