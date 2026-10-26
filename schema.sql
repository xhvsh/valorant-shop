-- valorant shop Supabase schema.
-- Run this once in the Supabase SQL editor (Project -> SQL Editor).

create table if not exists accounts (
  discord_id text primary key,
  puuid text,
  name text,
  shard text,
  auth_encrypted text,
  store_cache jsonb,
  store_updated_at timestamptz,
  updated_at timestamptz default now()
);
-- Multi-account migration: one row per linked Riot account, keyed by
-- (discord_id, puuid). A single Riot account (puuid) may be linked by more
-- than one Discord user, so puuid alone is NOT unique. Run once. Existing
-- single-row users keep working: their row becomes the default. Safe to
-- re-run (backfill only touches users whose rows are all non-default).
alter table accounts add column if not exists label text;
alter table accounts add column if not exists is_default boolean default false;
alter table accounts add column if not exists created_at timestamptz default now();
update accounts a
set is_default = true,
    label = coalesce(label, name)
where is_default = false
  and (select count(*) from accounts b where b.discord_id = a.discord_id) = 1;
alter table accounts drop constraint if exists accounts_pkey;
do $$
begin
  if exists (select 1 from accounts where puuid is null) then
    raise notice 'accounts rows with null puuid exist; have those users /link again, then re-run this block';
  elsif not exists (
    select 1 from pg_constraint where conname = 'accounts_discord_puuid_pkey'
  ) then
    alter table accounts add primary key (discord_id, puuid);
  end if;
end $$;

-- A Riot account may now be linked by more than one Discord user, so drop any
-- leftover UNIQUE constraint or index on puuid alone. The composite primary
-- key (discord_id, puuid) still prevents the same user linking one account
-- twice. Safe to re-run.
do $$
declare r record;
begin
  for r in
    select i.indexrelid as idx, c.conname as conname
    from pg_index i
    left join pg_constraint c on c.conindid = i.indexrelid
    join pg_class t on t.oid = i.indrelid
    where t.relname = 'accounts'
      and i.indisunique
      and (
        select array_agg(a.attname order by a.attname)
        from pg_attribute a
        where a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      ) = array['puuid']
  loop
    if r.conname is not null then
      execute 'alter table accounts drop constraint ' || quote_ident(r.conname);
    else
      execute 'drop index ' || r.idx::regclass;
    end if;
  end loop;
end $$;

-- link_codes was retired with the code-based /link flow (dashboard add-account
-- uses the Discord session instead). Drop it if it exists from before.
drop table if exists link_codes;

create table if not exists sessions (
  sid text primary key,
  data jsonb not null,
  expires_at timestamptz not null
);

create table if not exists kv (
  key text primary key,
  value text,
  expires_at timestamptz
);

-- Housekeeping: dead sessions / expired one-time links.
create or replace function cleanup_expired() returns void language sql security definer as $$
  delete from sessions where expires_at < now();
  delete from kv where expires_at < now();
$$;
-- Run cleanup_expired() on a schedule (Database -> pg_cron, e.g. every hour),
-- or rely on the bot's delete-on-read. These indexes keep both paths cheap.
create index if not exists sessions_expires_at_idx on sessions (expires_at);
create index if not exists kv_expires_at_idx on kv (expires_at);

-- Access control: the bot uses the service_role key, which bypasses row-level
-- security, so it keeps full access. Everyone else (anon, authenticated) gets
-- nothing: these tables hold encrypted Riot tokens, sessions, and DM subs.
alter table accounts enable row level security;
alter table sessions enable row level security;
alter table kv enable row level security;
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;