#!/usr/bin/env python3
"""IQ Algo minute-bar engine loop (local worker).

Runs the three ported Pine engines over intraday 1-minute bars for a small
"hot list" of tickers, fingerprints the engine STATE per ticker, diffs it
against the previous cycle, and publishes every state change to a local
events log plus (optionally) Supabase. NO LLM calls here — reads stay on
the daily/on-demand layer (ai/worker).

HOT LIST (rebuilt on start and every HOT_REFRESH s, default 900):
  Source: the repo's own scanner output docs/iq/{events,scan}.json (local
  checkout first, https://piraci26.github.io/iq-data/iq/ fallback).
  Recipe: distinct syms with events today (noisy *_ungated variants
  dropped, mcap-desc), backfilled with top-mcap scan tickers up to
  HOT_LIST_SIZE (default 40).

BARS: Yahoo v8 chart API range=1d&interval=1m per ticker via scanner.py's
  curl-first fetch helper, ~YAHOO_DELAY_M s spacing (default 1.5 — a
  40-ticker cycle paces itself to ~60s). The still-forming last minute bar
  is dropped (confirmed bars only, as the engines assume). EXTENDED=1 adds
  includePrePost=true.

ENGINES: scanner.run_engines (bands + oscillator + structure; structure
  computes both its internal and major tier in one pass, so it runs whole).

STATE: fingerprint + diff exactly like ai/worker/worker.py (its
  fingerprint_of/FP_FIELDS/extract_ticker are imported, not duplicated) —
  state-defining fields only, never prices. Changes append to
  minute/state/events.jsonl AND queue for Supabase/the live tape --
  except struct_events clears (a fired set emptying next bar), which are
  state-tracking only: new fired events reach the tape once, under the
  engine's own event names.

SINKS (each failure-tolerant, both optional):
  a) minute/out/live.json  {updated_at, tickers: {SYM: {...}},
     recent_events: [last 200]}  (atomic tmp+rename)
  b) Supabase via minute/supa.py (env SUPABASE_URL + SUPABASE_SERVICE_KEY;
     target = the trend-iq project zuhpyynilcqfgufexgli, never the friend's
     fmjz tht-data project): upsert minute_states on sym, append-insert
     minute_events. Env missing -> logged once, local-only continues.

LOOP: --loop gates on US market hours (America/New_York via zoneinfo,
  Mon-Fri 09:30-16:00; EXTENDED=1 widens to 04:00-20:00; conservative UTC
  fallback if tzdata is unavailable); outside hours it sleeps SLEEP_CLOSED
  (default 300s). In-hours cycles are floored at MIN_CYCLE s (default 60).
  --once always runs regardless of the clock (smoke tests).

CLI:
  minute_worker.py --once [--symbols AAPL,MSFT] [--dry]
  minute_worker.py --loop [--dry]

Env: HOT_LIST_SIZE, HOT_REFRESH, YAHOO_DELAY_M, MIN_BARS_M (default 30),
  EXTENDED, SLEEP_CLOSED, MIN_CYCLE, SUPABASE_URL, SUPABASE_SERVICE_KEY.
Pure stdlib + this repo's own modules.
"""

import argparse
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

MINUTE_DIR = Path(__file__).resolve().parent
REPO_DIR = MINUTE_DIR.parent
sys.path.insert(0, str(MINUTE_DIR))                    # supa.py
sys.path.insert(0, str(REPO_DIR / "ai" / "worker"))    # worker.py helpers
sys.path.insert(0, str(REPO_DIR))                      # scanner.py (+engines)

import scanner           # noqa: E402  fetch/retry + run_engines + collect side logic
import worker as aiw     # noqa: E402  ai/worker/worker.py: fingerprint helpers
import supa              # noqa: E402  PostgREST sink

STATE_DIR = MINUTE_DIR / "state"
OUT_DIR = MINUTE_DIR / "out"
STATE_FILE = STATE_DIR / "last_states.json"
EVENTS_FILE = STATE_DIR / "events.jsonl"
LIVE_FILE = OUT_DIR / "live.json"

IQ_BASE_URL = "https://piraci26.github.io/iq-data/iq"
DOCS_IQ = REPO_DIR / "docs" / "iq"

YAHOO_1M_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/"
                "{sym}?range=" + os.environ.get("YAHOO_1M_RANGE", "5d") +
                "&interval=1m{prepost}")

HOT_LIST_SIZE = int(os.environ.get("HOT_LIST_SIZE", "40"))
HOT_REFRESH = float(os.environ.get("HOT_REFRESH", "900"))
YAHOO_DELAY_M = float(os.environ.get("YAHOO_DELAY_M", "1.5"))
MIN_BARS_M = int(os.environ.get("MIN_BARS_M", "30"))
EXTENDED = os.environ.get("EXTENDED", "0").strip() == "1"
SLEEP_CLOSED = float(os.environ.get("SLEEP_CLOSED", "300"))
MIN_CYCLE = float(os.environ.get("MIN_CYCLE", "60"))
RECENT_EVENTS_MAX = 200
TF = "m1"

# The short-term product runs on a FIXED retail-favorite list, not the
# mcap-ranked hot list: the audience watches the same ~25 names every day.
# Override with HOT_SYMBOLS="AAPL,TSLA,..." without touching code.
RETAIL_25 = [
    "SPY", "QQQ", "TSLA", "NVDA", "AAPL", "AMD", "PLTR", "META", "AMZN",
    "MSFT", "GOOGL", "NFLX", "COIN", "HOOD", "SOFI", "MARA", "RIOT", "GME",
    "AMC", "SMCI", "INTC", "MU", "F", "NIO", "BABA",
    # Crypto majors trade around the clock; the loop scans them 24/7 and
    # equities only while the US session is on.
    "BTC-USD", "ETH-USD",
]


def is_crypto(sym):
    return sym.endswith("-USD")
HOT_SYMBOLS = [s.strip().upper()
               for s in os.environ.get("HOT_SYMBOLS", "").split(",")
               if s.strip()]

# Short-term clocks: 5m and 15m are epoch-bucket resamples of the 1m feed.
# US regular session opens on a :30 boundary, so epoch alignment == session
# alignment for both clocks.
CLOCKS = (("m1", 60), ("m5", 300), ("m15", 900))

log = aiw.log
now_iso = aiw.now_iso

# --------------------------------------------------------------------- hours


def _ny_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York"))
    except Exception:
        return None


def market_open(extended=EXTENDED):
    """True while the US session is on. NY-local when tzdata is available;
    otherwise a conservative UTC union of EDT+EST bounds (house preference:
    scanner.py's 21:00-UTC fallback)."""
    ny = _ny_now()
    if ny is not None:
        if ny.weekday() >= 5:
            return False
        mins = ny.hour * 60 + ny.minute
        if extended:
            return 4 * 60 <= mins < 20 * 60          # 04:00-20:00 ET
        return 9 * 60 + 30 <= mins < 16 * 60         # 09:30-16:00 ET
    utc = datetime.now(timezone.utc)
    if utc.weekday() >= 5:
        return False
    mins = utc.hour * 60 + utc.minute
    if extended:
        return 8 * 60 <= mins                        # 08:00-24:00 UTC
    return 13 * 60 + 30 <= mins < 21 * 60            # union of EDT/EST regular

# ------------------------------------------------------------------ hot list


def _load_iq_doc(name):
    """docs/iq/<name> from the local checkout, falling back to the
    published GitHub Pages copy. None on total failure."""
    try:
        return json.loads((DOCS_IQ / name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    try:
        return scanner._http_json(IQ_BASE_URL + "/" + name)
    except Exception as e:
        log("hot list: fetch failed for %s (%s)" % (name, e))
        return None


def build_hot_list(size=HOT_LIST_SIZE):
    """Fixed retail list (HOT_SYMBOLS env, else RETAIL_25). The legacy
    event-driven mcap list below survives only as a fallback if both fixed
    sources are emptied via env."""
    fixed = HOT_SYMBOLS or RETAIL_25
    if fixed:
        return list(fixed)
    events_doc = _load_iq_doc("events.json") or {}
    scan_doc = _load_iq_doc("scan.json") or {}
    tickers = scan_doc.get("tickers") if isinstance(scan_doc, dict) else None
    tickers = tickers if isinstance(tickers, dict) else {}
    mcap = {s: (r.get("mcap") or 0.0) for s, r in tickers.items()
            if isinstance(r, dict)}

    seen, ev_syms = set(), []
    for ev in (events_doc.get("events") or []):
        if not isinstance(ev, dict):
            continue
        if str(ev.get("event", "")).endswith("_ungated"):
            continue  # deliberately dropped noise (mirrors ai worker)
        s = ev.get("sym")
        if s and s not in seen:
            seen.add(s)
            ev_syms.append(s)
    ev_syms.sort(key=lambda s: -mcap.get(s, 0.0))
    hot = ev_syms[:size]
    if len(hot) < size:
        for s in sorted(tickers, key=lambda s: -mcap.get(s, 0.0)):
            if s not in seen:
                hot.append(s)
                seen.add(s)
                if len(hot) >= size:
                    break
    return hot

# ---------------------------------------------------------------------- bars


def fetch_minute(sym, retries=1):
    """Confirmed 1m bars for today: (ts_epochs, o, h, l, c, v) or None.
    Null-field rows are dropped (volume None -> 0.0 — thin minutes are
    real bars); the still-forming last minute is dropped."""
    url = YAHOO_1M_URL.format(
        sym=urllib.request.quote(sym),
        prepost="&includePrePost=true" if EXTENDED else "")
    last_err = None
    for attempt in range(retries + 1):
        try:
            data = scanner._http_json(url)
            break
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(max(YAHOO_DELAY_M, 0.5))
    else:
        log("  %s: 1m fetch failed (%s)" % (sym, last_err))
        return None

    try:
        res = data["chart"]["result"][0]
        ts_raw = res["timestamp"]
        q = res["indicators"]["quote"][0]
        oo, hh, ll, cc, vv = (q["open"], q["high"], q["low"],
                              q["close"], q["volume"])
    except (KeyError, IndexError, TypeError) as e:
        log("  %s: bad 1m payload (%s)" % (sym, e))
        return None

    ts, o, h, l, c, v = [], [], [], [], [], []
    for i in range(len(ts_raw)):
        row = (oo[i], hh[i], ll[i], cc[i])
        if any(x is None for x in row):
            continue
        if ts and ts_raw[i] == ts[-1]:
            continue  # Yahoo's duplicate regularMarketTime tail bar
        ts.append(int(ts_raw[i]))
        o.append(float(row[0])); h.append(float(row[1]))
        l.append(float(row[2])); c.append(float(row[3]))
        v.append(float(vv[i]) if vv[i] is not None else 0.0)

    # confirmed-bar guard: minute bar at ts covers [ts, ts+60)
    if ts and time.time() < ts[-1] + 60:
        for series in (ts, o, h, l, c, v):
            series.pop()

    if len(c) < MIN_BARS_M:
        return None
    return ts, o, h, l, c, v

# --------------------------------------------------------------- fingerprint


def resample_clock(ts, o, h, l, c, v, secs):
    """Epoch-bucket OHLCV resample of the 1m arrays (last bucket = forming
    bucket built only from confirmed 1m bars, matching the 1m clock's own
    confirmed-bar policy)."""
    RT, RO, RH, RL, RC, RV = [], [], [], [], [], []
    cur = None
    for i in range(len(ts)):
        b = ts[i] - (ts[i] % secs)
        if b != cur:
            cur = b
            RT.append(b)
            RO.append(o[i]); RH.append(h[i]); RL.append(l[i])
            RC.append(c[i]); RV.append(v[i])
        else:
            RH[-1] = max(RH[-1], h[i])
            RL[-1] = min(RL[-1], l[i])
            RC[-1] = c[i]
            RV[-1] += v[i]
    return RT, RO, RH, RL, RC, RV


def fingerprint(engines_result):
    """Single-tf fingerprint via the ai worker's own extraction: wrap the
    minute engine output as a scan.json-shaped 'd' row so scanner field
    drift stays a one-function fix (aiw.extract_ticker)."""
    norm = aiw.extract_ticker({"d": engines_result})
    tfd = norm["tfs"].get("daily")
    return aiw.fingerprint_of(tfd) if tfd else {}


def diff_fp(old, new):
    """Flat single-tf diff over the ai worker's FP_FIELDS."""
    changes = []
    for field in aiw.FP_FIELDS:
        ov, nv = old.get(field), new.get(field)
        if ov != nv:
            changes.append({"field": field, "from": ov, "to": nv})
    return changes


_ENGINE_OF_FIELD = {"bands": "bands", "osc": "osc", "osc_hi": "osc",
                    "osc_lo": "osc", "struct": "structure",
                    "struct_major": "structure",
                    "struct_events": "structure"}
_TO_SIDE = {"bull": "long", "bear": "short"}


def changes_to_events(sym, bar_iso, changes, price, tf=TF):
    """Fingerprint changes -> minute_events rows (also the live-tape shape).

    Scalar fields become one "field:from->to" row; side derives from the
    'to' value when it is a regime word. struct_events is the per-bar
    "what fired" set: each NEWLY fired engine event becomes its own row
    under the engine's own event name (the nightly events.json vocabulary),
    side via scanner's hint table. The inevitable clear on the next bar
    (elements leaving the set) is state-tracking, not a tape event -- it
    stays in events.jsonl/last_states but produces no tape row."""
    rows = []
    for change in changes:
        field, to = change["field"], change["to"]
        if field == "struct_events":
            old = set(change["from"]) if isinstance(change["from"], list) else set()
            new = set(to) if isinstance(to, list) else set()
            for name in sorted(new - old):
                rows.append({"sym": sym, "ts": bar_iso, "tf": tf,
                             "engine": "structure", "event": name,
                             "side": scanner._event_side(name),
                             "payload": {"change": change, "price": price}})
            continue
        side = _TO_SIDE.get(to) if isinstance(to, str) else None
        rows.append({"sym": sym, "ts": bar_iso, "tf": tf,
                     "engine": _ENGINE_OF_FIELD.get(field, "structure"),
                     "event": "%s:%s->%s" % (field, change["from"], to),
                     "side": side,
                     "payload": {"change": change, "price": price}})
    return rows

# --------------------------------------------------------------------- sinks


def append_jsonl(rows):
    if not rows:
        return
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with EVENTS_FILE.open("a", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")


def push_supabase(state_rows, event_rows, dry):
    """Best-effort: a Supabase outage must never kill the cycle."""
    if dry or not supa.available():
        supa._disabled()  # prints the one-time keyless hint
        return "off"
    try:
        if supa.ingest_available():
            supa.ingest(state_rows, event_rows)
        else:
            supa.upsert("minute_states", state_rows, on_conflict="sym")
            supa.insert("minute_events", event_rows)
        return "ok(%d/%d)" % (len(state_rows), len(event_rows))
    except Exception as e:
        log("supabase push failed (continuing local-only): %s" % e)
        return "fail"

# --------------------------------------------------------------------- cycle


def run_cycle(hot, dry):
    t0 = time.monotonic()
    old_state = aiw.load_json(STATE_FILE, {})
    if not isinstance(old_state, dict):
        old_state = {}
    live_prev = aiw.load_json(LIVE_FILE, {})
    recent = live_prev.get("recent_events") if isinstance(live_prev, dict) else None
    recent = recent if isinstance(recent, list) else []

    new_state = dict(old_state)   # keep syms that rotated off the hot list
    live_tickers, jsonl_rows, event_rows, state_rows = {}, [], [], []
    ok = skip = 0
    ts_now = now_iso()

    for idx, sym in enumerate(hot):
        if idx:
            time.sleep(YAHOO_DELAY_M)
        fetched = fetch_minute(sym)
        if fetched is None:
            skip += 1
            continue
        ts, o, h, l, c, v = fetched
        price = round(c[-1], 4)
        old_entry = old_state.get(sym) or {}
        old_clocks = old_entry.get("clocks") or {}
        # pre-multi-clock states stored one flat m1 fingerprint
        if not old_clocks and old_entry.get("fingerprint"):
            old_clocks = {"m1": {"fingerprint": old_entry["fingerprint"]}}

        clocks_entry = {}
        clocks_live = {}
        regimes = {}
        any_changes = False
        for tf_name, secs in CLOCKS:
            if secs == 60:
                bt, bo, bh, bl, bc, bv = ts, o, h, l, c, v
            else:
                bt, bo, bh, bl, bc, bv = resample_clock(ts, o, h, l, c, v, secs)
            if len(bc) < 40:
                continue  # clock not warmed up yet
            eng = scanner.run_engines(bo, bh, bl, bc, bv,
                                      with_structure=(tf_name == "m1"))
            fp = fingerprint(eng)
            bar_iso = datetime.fromtimestamp(bt[-1], timezone.utc).isoformat(
                timespec="seconds")
            bands = eng.get("bands") or {}
            regime = bands.get("regime")
            if regime in ("bull", "bear"):
                regimes[tf_name] = regime

            old_fp = (old_clocks.get(tf_name) or {}).get("fingerprint") or {}
            changes = diff_fp(old_fp, fp)
            if changes:
                any_changes = True
                jsonl_rows.append({"ts": ts_now, "ticker": sym, "tf": tf_name,
                                   "bar": bar_iso, "price": price,
                                   "changes": changes})
                event_rows += changes_to_events(sym, bar_iso, changes, price,
                                                tf=tf_name)
            clocks_entry[tf_name] = {"fingerprint": fp,
                                     "hash": aiw.fingerprint_hash(fp)}
            clocks_live[tf_name] = {"regime": regime,
                                    "age": bands.get("regime_age"),
                                    "bars": len(bc), "last_bar": bar_iso}

        if not clocks_entry:
            skip += 1
            continue

        # Short-term triple: all three clocks on one side, or nothing.
        new_side = None
        if len(regimes) == len(CLOCKS) and len(set(regimes.values())) == 1:
            new_side = next(iter(regimes.values()))
        old_triple = old_entry.get("triple") or {}
        old_side = old_triple.get("side")
        triple = {"side": new_side,
                  "since": ts_now if new_side != old_side
                  else old_triple.get("since", ts_now)}
        if new_side != old_side:
            any_changes = True
            if new_side:
                event_rows.append({"sym": sym, "ts": ts_now, "tf": "triple",
                                   "engine": "triple",
                                   "event": "short_term_triple_lock",
                                   "side": _TO_SIDE.get(new_side),
                                   "payload": {"regimes": regimes,
                                               "price": price}})
            else:
                event_rows.append({"sym": sym, "ts": ts_now, "tf": "triple",
                                   "engine": "triple",
                                   "event": "short_term_triple_release",
                                   "side": _TO_SIDE.get(old_side),
                                   "payload": {"regimes": regimes,
                                               "price": price}})

        entry = {"clocks": clocks_entry, "triple": triple,
                 "updated_at": ts_now if any_changes
                 else old_entry.get("updated_at", ts_now)}
        new_state[sym] = entry
        live_tickers[sym] = {"price": price,
                             "clocks": clocks_live,
                             "triple": triple,
                             "state_updated_at": entry["updated_at"]}
        state_rows.append({"sym": sym, "updated_at": ts_now,
                           "payload": {"price": price,
                                       "clocks": clocks_live,
                                       "triple": triple}})
        ok += 1

    # Failure tolerance for the live view: a hot sym whose fetch failed this
    # cycle keeps its previous live.json row (staleness stays visible via
    # last_bar / state_updated_at) instead of vanishing, so a total Yahoo
    # outage cannot blank live.json. Rotated-off syms still drop out.
    prev_tickers = live_prev.get("tickers") if isinstance(live_prev, dict) else None
    if isinstance(prev_tickers, dict):
        for s in hot:
            if s not in live_tickers and isinstance(prev_tickers.get(s), dict):
                live_tickers[s] = prev_tickers[s]

    append_jsonl(jsonl_rows)
    aiw.atomic_write_json(STATE_FILE, new_state)

    for ev in event_rows:
        recent.append({k: ev[k] for k in
                       ("sym", "ts", "tf", "engine", "event", "side")})
    recent = recent[-RECENT_EVENTS_MAX:]
    aiw.atomic_write_json(LIVE_FILE, {"updated_at": ts_now,
                                      "tickers": live_tickers,
                                      "recent_events": recent})

    supa_status = push_supabase(state_rows, event_rows, dry)
    log("cycle: %d syms ok=%d skip=%d changes=%d events=%d supa=%s %.1fs"
        % (len(hot), ok, skip, len(jsonl_rows), len(event_rows),
           supa_status, time.monotonic() - t0))

# ---------------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(description="IQ Algo minute-bar worker")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true",
                      help="single cycle, ignores market hours")
    mode.add_argument("--loop", action="store_true",
                      help="run forever, gated on US market hours")
    ap.add_argument("--symbols", default=None,
                    help="comma list debug subset (bypasses hot list)")
    ap.add_argument("--dry", action="store_true", help="no supabase writes")
    args = ap.parse_args(argv)

    fixed = None
    if args.symbols:
        fixed = [s.strip().upper() for s in args.symbols.split(",")
                 if s.strip()]

    log("minute worker starting: hot=%s extended=%s supa=%s"
        % (fixed or ("top %d" % HOT_LIST_SIZE), EXTENDED,
           "on" if (supa.available() and not args.dry) else "off"))

    hot = fixed or build_hot_list()
    if not hot:
        log("FATAL: empty hot list and no --symbols")
        return 1
    log("hot list (%d): %s" % (len(hot), ",".join(hot)))
    last_refresh = time.monotonic()

    if args.once:
        run_cycle(hot, args.dry)
        return 0

    open_logged = closed_logged = False
    while True:
        equities_on = market_open()
        active = hot if equities_on else [s for s in hot if is_crypto(s)]
        if not active:
            if not closed_logged:
                log("market closed, no 24/7 symbols -- sleeping %.0fs"
                    % SLEEP_CLOSED)
                closed_logged, open_logged = True, False
            time.sleep(SLEEP_CLOSED)
            continue
        if equities_on and not open_logged:
            log("market open -- full list minute cycles")
            open_logged, closed_logged = True, False
        elif not equities_on and not closed_logged:
            log("equities closed -- crypto-only cycles (%s)"
                % ",".join(active))
            closed_logged, open_logged = True, False

        if fixed is None and time.monotonic() - last_refresh >= HOT_REFRESH:
            fresh = build_hot_list()
            if fresh:
                if fresh != hot:
                    log("hot list refreshed (%d): %s"
                        % (len(fresh), ",".join(fresh)))
                hot = fresh
            last_refresh = time.monotonic()

        started = time.monotonic()
        try:
            run_cycle(active, args.dry)
        except Exception as exc:  # the loop must survive anything
            log("cycle crashed: %s: %s" % (type(exc).__name__, exc))
        elapsed = time.monotonic() - started
        if elapsed < MIN_CYCLE:
            time.sleep(MIN_CYCLE - elapsed)


if __name__ == "__main__":
    sys.exit(main())
