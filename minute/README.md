# IQ Algo minute layer -- service files

Intraday worker that maintains per-symbol minute state locally and (optionally)
mirrors it to Supabase so the trend-iq site can read it live.

Files in this directory:

| File | Purpose |
|---|---|
| `minute_worker.py` | The worker itself (`--loop` = daemon mode) |
| `migration.sql` | Supabase schema -- paste once into the SQL editor |
| `com.iqalgo.minute-worker.plist` | LaunchAgent definition |
| `install.sh` | Install / uninstall / status for the LaunchAgent |
| `logs/` | LaunchAgent stdout/stderr |

## Run modes

1. **One-shot, local-only** (no env needed):
   `/usr/bin/python3 minute_worker.py`
2. **Loop in the foreground**:
   `/usr/bin/python3 minute_worker.py --loop`
3. **Managed service** (recommended):
   `./install.sh` -- copies the plist to `~/Library/LaunchAgents`, bootstraps
   and kickstarts it. `KeepAlive` means launchd restarts it if it dies.
   `./install.sh --uninstall` removes it; `./install.sh --status` checks it.

## Environment

| Variable | Meaning |
|---|---|
| `SUPABASE_URL` | `https://zuhpyynilcqfgufexgli.supabase.co` (trend-iq site project) |
| `SUPABASE_SERVICE_KEY` | That project's **service_role** key (dashboard > Settings > API) |

Both unset/empty = **local-only mode**: the worker still runs and writes local
outputs, it just skips all Supabase writes (same env-gating pattern as
`tht-data/supabase_client.py`). For the LaunchAgent, the env lives in the
`EnvironmentVariables` block of the plist -- fill it in and re-run
`./install.sh` (launchd only reads it at bootstrap time).

Warnings:

- No service-role key for the trend-iq project exists on disk today. It must
  be copied from the Supabase dashboard.
- Do **not** reuse `SUPABASE_SERVICE_KEY` from `~/tht-data/.env` -- that key
  belongs to the friend's `fmjzserpkgffqiwfnmii` project, not this one.
- The service key bypasses RLS. It belongs only in the plist / server env,
  never in trend-iq frontend code or anything prefixed `VITE_`.

## One-time Supabase setup

1. Open the **trend-iq** project (`zuhpyynilcqfgufexgli`) in the Supabase
   dashboard -- not the tht-data one.
2. SQL Editor > paste all of `migration.sql` > Run. It is idempotent;
   re-running is harmless.
3. Creates `minute_states` (latest payload per symbol, upsert-on-PK) and
   `minute_events` (append-only stream, indexed on `(sym, ts desc)`), with
   RLS enabled: anon/authenticated may SELECT, only the service role can write.

## How the site consumes it

The existing browser client (`src/integrations/supabase/client.ts`, anon
publishable key) can read both tables directly -- RLS allows SELECT only:

```ts
// Latest state for one symbol
const { data } = await supabase
  .from("minute_states")
  .select("payload, updated_at")
  .eq("sym", "AAPL")
  .maybeSingle();

// Recent events tape
const { data: events } = await supabase
  .from("minute_events")
  .select("sym, ts, tf, engine, event, side")
  .order("ts", { ascending: false })
  .limit(50);
```

No server route is required for reads; writes are impossible with the anon key
(no insert/update/delete policies exist).
