-- ============================================================================
-- IQ Algo minute layer -- Supabase migration
--
-- TARGET PROJECT: the trend-iq SITE project
--   https://zuhpyynilcqfgufexgli.supabase.co
--   Dashboard > SQL Editor > paste this whole file > Run.
--
-- DO NOT run this in the tht-data pipeline project
-- (fmjzserpkgffqiwfnmii.supabase.co) -- that is the friend's project,
-- a different Supabase instance entirely.
--
-- Idempotent: safe to paste and re-run any number of times.
--
-- Write path : minute_worker.py using the SERVICE ROLE key (bypasses RLS).
-- Read path  : the trend-iq site via the anon/publishable client
--              (RLS enabled below, SELECT-only policies -- anon cannot write).
-- ============================================================================

-- Latest per-symbol state. Pure upsert-on-PK by design: no wipe-and-reload,
-- so readers never observe an empty or partial table mid-run.
create table if not exists public.minute_states (
  sym        text primary key,
  payload    jsonb not null,
  updated_at timestamptz not null
);

-- Append-only event stream.
create table if not exists public.minute_events (
  id         bigserial primary key,
  sym        text not null,
  ts         timestamptz not null,
  tf         text,
  engine     text,
  event      text,
  side       text,
  payload    jsonb,
  created_at timestamptz default now()
);

-- "Recent events for symbol" queries.
create index if not exists minute_events_sym_ts_idx
  on public.minute_events (sym, ts desc);

-- OPTIONAL (commented out): makes event writes idempotent so a re-run of the
-- same scan cannot double-insert. Only enable if the worker upserts with
-- on_conflict=sym,ts,tf,engine,event instead of plain inserts.
-- create unique index if not exists minute_events_dedupe_idx
--   on public.minute_events (sym, ts, tf, engine, event);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.minute_states enable row level security;
alter table public.minute_events enable row level security;

-- Anyone (anon visitor or logged-in site user) may read. No insert/update/
-- delete policies exist, so the publishable key cannot write anything;
-- the service-role key bypasses RLS and is the only write path.
drop policy if exists "minute_states anon read" on public.minute_states;
create policy "minute_states anon read"
  on public.minute_states for select
  to anon, authenticated
  using (true);

drop policy if exists "minute_events anon read" on public.minute_events;
create policy "minute_events anon read"
  on public.minute_events for select
  to anon, authenticated
  using (true);
