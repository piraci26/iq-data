-- Quant: saved scripts move from the browser to the account.
-- One row per script; versions are the same JSON the client keeps locally,
-- so the local cache and this table can merge by id and updated_at.
create table if not exists public.quant_scripts (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  chat_id text,
  versions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.quant_scripts enable row level security;

create policy "quant_scripts_select_own" on public.quant_scripts
  for select using (auth.uid() = user_id);
create policy "quant_scripts_insert_own" on public.quant_scripts
  for insert with check (auth.uid() = user_id);
create policy "quant_scripts_update_own" on public.quant_scripts
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "quant_scripts_delete_own" on public.quant_scripts
  for delete using (auth.uid() = user_id);

create index if not exists quant_scripts_user_updated_idx
  on public.quant_scripts (user_id, updated_at desc);
