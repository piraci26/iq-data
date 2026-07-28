"""Minimal Supabase PostgREST client for the minute-bar layer.

Modeled on the house pattern (tht-data/supabase_client.py): pure stdlib
urllib, env-gated no-op when keys are missing, chunked writes, PGRST204
schema-drift recovery. Differences, deliberate:

- UPSERT-ONLY design. There is no truncate()/delete here — the minute
  tables are written by primary-key upsert (minute_states) and append-only
  insert (minute_events), so readers never observe a wiped/partial table
  mid-write (the known caveat of the tht-data wipe-then-upsert flow).

Env vars expected (same names as tht-data + iq-data/ai/worker/sync_supabase):
  SUPABASE_URL          e.g. https://zuhpyynilcqfgufexgli.supabase.co
                        (the trend-iq project — NOT the friend's
                        fmjzserpkgffqiwfnmii tht-data project)
  SUPABASE_SERVICE_KEY  service_role key. Never commit. Currently unset
                        everywhere on this machine — copy it from the
                        Supabase dashboard (Settings > API) when going live.

When either is missing all writes are no-ops and a hint prints once, so
the worker keeps producing its local JSON output keyless.

Expected tables (create via SQL editor / migration):
  minute_states (sym text primary key, payload jsonb, updated_at timestamptz)
  minute_events (id bigserial primary key, sym text, ts timestamptz,
                 tf text, engine text, event text, side text, payload jsonb)
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

_PRINTED_DISABLED_HINT = False


def available():
    return bool(os.environ.get("SUPABASE_URL")
                and os.environ.get("SUPABASE_SERVICE_KEY"))


def _disabled():
    global _PRINTED_DISABLED_HINT
    if not available():
        if not _PRINTED_DISABLED_HINT:
            print("supa: SUPABASE_URL / SUPABASE_SERVICE_KEY not set -- "
                  "Supabase writes skipped (local-only mode).",
                  file=sys.stderr)
            _PRINTED_DISABLED_HINT = True
        return True
    return False


def _headers(merge):
    key = os.environ["SUPABASE_SERVICE_KEY"].strip()
    prefer = "return=minimal"
    if merge:
        # PostgREST upsert semantics: insert OR update on PK conflict.
        prefer = "resolution=merge-duplicates," + prefer
    return {"Content-Type": "application/json",
            "apikey": key,
            "Authorization": "Bearer " + key,
            "Prefer": prefer}


def _url(table, on_conflict=None):
    base = os.environ["SUPABASE_URL"].strip().rstrip("/") + "/rest/v1/" + table
    if on_conflict:
        base += "?on_conflict=" + on_conflict
    return base


def _write(table, rows, on_conflict, merge, chunk):
    """Shared POST path for upsert/insert. Returns rows sent.

    PGRST204 recovery: on 400 "Could not find the 'X' column" the offending
    column is dropped (max 8) and the batch retried, so partial schema still
    lands instead of the whole write dying."""
    if _disabled() or not rows:
        return 0
    headers = _headers(merge)
    sent = 0
    dropped = set()
    i = 0
    while i < len(rows):
        batch = rows[i:i + chunk]
        if dropped:
            batch = [{k: v for k, v in r.items() if k not in dropped}
                     for r in batch]
        body = json.dumps(batch).encode("utf-8")
        req = urllib.request.Request(_url(table, on_conflict), data=body,
                                     headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                resp.read()  # discard; return=minimal
            sent += len(batch)
            i += chunk
        except urllib.error.HTTPError as e:
            body_str = e.read().decode("utf-8", "replace")
            m = re.search(r"Could not find the '([^']+)' column", body_str)
            if e.code == 400 and m and len(dropped) < 8:
                dropped.add(m.group(1))
                print("  [supa] %s: live schema missing column '%s' -- "
                      "writing without it." % (table, m.group(1)),
                      file=sys.stderr)
                continue  # retry this batch minus the unknown column
            raise RuntimeError("supa %s %s failed: %s %s"
                               % ("upsert" if merge else "insert",
                                  table, e.code, body_str[:300])) from e
    return sent


def upsert(table, rows, on_conflict, chunk=500):
    """Upsert rows on the given comma-separated PK columns (e.g. "sym")."""
    return _write(table, rows, on_conflict, merge=True, chunk=chunk)


def insert(table, rows, chunk=500):
    """Plain append-only insert (bigserial-id event tables)."""
    return _write(table, rows, None, merge=False, chunk=chunk)
