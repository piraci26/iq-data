#!/usr/bin/env python3
"""IQ Algo nightly scanner — runs the three ported Pine engines over the
tht-data universe and writes docs/iq/scan.json + docs/iq/events.json.

Pipeline:
  1. Universe: fetch https://piraci26.github.io/tht-data/universe_filtered.json
     (fallback /universe.json, plain-list format accepted) and
     /mcap_cache.json for USD market caps. READ-ONLY public fetches —
     this project never writes to tht-data. Keep top N by mcap
     (UNIVERSE_TOP env / --top, default 500).
  2. Bars: daily OHLCV per ticker from the Yahoo Finance v8 chart API
     (query1.finance.yahoo.com/v8/finance/chart/SYM?range=<BAR_RANGE>&
     interval=1d), pure urllib, ~0.15s spacing, retry-once, skip-on-fail.
     The last daily bar is dropped when it belongs to a still-open
     regular session (confirmed bars only — the engines assume it).
     Weekly (ISO week) and monthly (calendar month) bars are resampled
     in code from the dailies; the current, still-running week/month is
     dropped so only confirmed periods are fed.
  3. Engines per ticker: daily -> bands + oscillator + structure;
     weekly & monthly -> bands + oscillator (structure is daily-only v1).
  4. Output (atomic tmp+rename, never partial):
       <out>/iq/scan.json   {updated_at, universe_size, scanned,
                             skipped, tickers: {SYM: {name, mcap, price,
                             d: {bands, osc, structure}, w: {...}, m: {...}}}}
       <out>/iq/events.json {updated_at, count, events: [{sym, tf,
                             engine, event, side}, ...]}
     MIN_OK guard (env MIN_OK, default 100): if fewer tickers survive,
     nothing is written and the previous output stays (mirrors the
     tht-data pipeline resilience pattern). --symbols debug runs bypass
     the guard.

CLI:
  scanner.py [--top N] [--symbols AAPL,MSFT] [--out DIR]

Env: UNIVERSE_TOP, MIN_OK, BAR_RANGE (default 2y; use 10y if you want
monthly bands/oscillator to fully warm up — at 2y monthly has only ~24
bars, so most monthly fields are None), YAHOO_DELAY (default 0.15).

Pure stdlib. Exit codes: 0 ok, 1 universe fetch failed, 2 MIN_OK guard.
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "engines"))
import bands            # noqa: E402
import oscillator       # noqa: E402
import structure        # noqa: E402

THT_BASE = "https://piraci26.github.io/tht-data"
YAHOO_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/"
             "{sym}?range={rng}&interval=1d")
# Keep the UA SHORT: Yahoo 429-blocks the long Chrome-impersonating UA
# string but accepts a plain "Mozilla/5.0" (verified 2026-07-28).
UA = "Mozilla/5.0"

MIN_BARS = 50          # skip tickers with fewer confirmed daily bars
LOG_EVERY = 50

# checked in order: whole-word hints first ("long" before "_lo", else
# exit_long / dual_long would match the "_lo" short hint)
_SIDE_HINTS = (("long", "long"), ("buy", "long"), ("bull", "long"),
               ("short", "short"), ("sell", "short"), ("bear", "short"),
               ("_up", "long"), ("_dn", "short"), ("_down", "short"),
               ("_hi", "long"), ("_lo", "short"), ("hit", "long"))


def _now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _curl_json(url, timeout):
    """Primary fetch via curl subprocess. Python's urllib suffers
    IncompleteRead on larger chunked responses in some proxy setups,
    so curl (with its own retries) is the reliable path. Still zero
    third-party dependencies."""
    import subprocess
    p = subprocess.run(
        ["curl", "-sf", "--max-time", str(int(timeout)),
         "--retry", "3", "--retry-delay", "1", "--retry-all-errors",
         "-A", UA, url],
        capture_output=True)
    if p.returncode != 0:
        raise RuntimeError("curl exit %d" % p.returncode)
    return json.loads(p.stdout.decode("utf-8"))


def _http_json(url, timeout=30):
    try:
        return _curl_json(url, timeout)
    except Exception:
        # curl missing/blocked -> one urllib attempt
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))


def fetch_universe():
    """Return ordered ticker list from tht-data (read-only)."""
    for path in ("/universe_filtered.json", "/universe.json"):
        try:
            data = _http_json(THT_BASE + path)
        except Exception as e:
            print("universe fetch failed %s: %s" % (path, e), file=sys.stderr)
            continue
        if isinstance(data, dict) and "tickers" in data:
            return list(data["tickers"])
        if isinstance(data, list):    # plain list format
            return [x if isinstance(x, str) else x.get("ticker")
                    for x in data if x]
    return None


def fetch_mcaps():
    """SYM -> mcap in USD billions (missing tickers -> 0.0)."""
    try:
        data = _http_json(THT_BASE + "/mcap_cache.json")
    except Exception as e:
        print("mcap_cache fetch failed: %s" % e, file=sys.stderr)
        return {}
    out = {}
    for sym, rec in data.items():
        if isinstance(rec, dict) and isinstance(rec.get("mcap_b"), (int, float)):
            out[sym] = float(rec["mcap_b"])
    return out


def fetch_daily(sym, rng, delay, retries=1):
    """Fetch confirmed daily bars for one ticker.

    Returns (name, dates, o, h, l, c, v) with dates as UTC date objects,
    or None on failure. Bars with any null field are dropped. The last
    bar is dropped when its regular session has not ended yet.
    """
    url = YAHOO_URL.format(sym=urllib.request.quote(sym), rng=rng)
    last_err = None
    for attempt in range(retries + 1):
        try:
            data = _http_json(url)
            break
        except Exception as e:
            last_err = e
            if attempt < retries:
                time.sleep(max(delay, 0.5))
    else:
        print("  %s: fetch failed (%s)" % (sym, last_err), file=sys.stderr)
        return None

    try:
        res = data["chart"]["result"][0]
        meta = res.get("meta", {})
        ts = res["timestamp"]
        q = res["indicators"]["quote"][0]
        oo, hh, ll, cc, vv = (q["open"], q["high"], q["low"],
                              q["close"], q["volume"])
    except (KeyError, IndexError, TypeError) as e:
        print("  %s: bad payload (%s)" % (sym, e), file=sys.stderr)
        return None

    name = meta.get("shortName") or meta.get("longName") or sym

    dates, o, h, l, c, v = [], [], [], [], [], []
    for i in range(len(ts)):
        row = (oo[i], hh[i], ll[i], cc[i], vv[i])
        if any(x is None for x in row):
            continue                      # holiday/partial null bar
        dates.append(datetime.fromtimestamp(ts[i], timezone.utc).date())
        o.append(float(row[0])); h.append(float(row[1]))
        l.append(float(row[2])); c.append(float(row[3]))
        v.append(float(row[4]))

    # confirmed-bar guard: drop today's bar if the session is still open
    if dates:
        now = time.time()
        reg = (meta.get("currentTradingPeriod") or {}).get("regular") or {}
        reg_start, reg_end = reg.get("start"), reg.get("end")
        drop = False
        if reg_start and reg_end:
            sess_date = datetime.fromtimestamp(reg_start, timezone.utc).date()
            drop = dates[-1] >= sess_date and now < reg_end
        else:  # fallback: same UTC date and before 21:00 UTC
            utcnow = datetime.now(timezone.utc)
            drop = (dates[-1] == utcnow.date() and utcnow.hour < 21)
        if drop:
            for series in (dates, o, h, l, c, v):
                series.pop()

    if len(c) < MIN_BARS:
        print("  %s: only %d confirmed bars, skipped" % (sym, len(c)),
              file=sys.stderr)
        return None
    return name, dates, o, h, l, c, v


def resample(dates, o, h, l, c, v, keyfn, drop_key):
    """Resample daily bars into (keyfn) periods: first open, max high,
    min low, LAST close wins, summed volume. The period drop_key (the
    still-running one) is excluded — confirmed periods only."""
    ro, rh, rl, rc, rv = [], [], [], [], []
    cur = None
    for i in range(len(dates)):
        k = keyfn(dates[i])
        if k == drop_key:
            continue
        if k != cur:
            cur = k
            ro.append(o[i]); rh.append(h[i]); rl.append(l[i])
            rc.append(c[i]); rv.append(v[i])
        else:
            rh[-1] = max(rh[-1], h[i])
            rl[-1] = min(rl[-1], l[i])
            rc[-1] = c[i]
            rv[-1] += v[i]
    return ro, rh, rl, rc, rv


def _week_key(d):
    iso = d.isocalendar()
    return (iso[0], iso[1])


def _month_key(d):
    return (d.year, d.month)


def run_engines(o, h, l, c, v, with_structure):
    """Run the engines defensively; a single engine blow-up on one ticker
    must not kill the scan."""
    out = {}
    try:
        out["bands"] = bands.scan(o, h, l, c, v)
    except Exception as e:
        out["bands"] = {"error": str(e)}
    try:
        out["osc"] = oscillator.scan(o, h, l, c, v)
    except Exception as e:
        out["osc"] = {"error": str(e)}
    if with_structure:
        try:
            out["structure"] = structure.scan(o, h, l, c, v)
        except Exception as e:
            out["structure"] = {"error": str(e)}
    return out


def _event_side(name):
    n = name.lower()
    for hint, side in _SIDE_HINTS:
        if hint in n:
            return side
    return None


def collect_events(sym, tf, engines):
    """Flatten every fired event on the last confirmed bar of this tf."""
    rows = []
    for eng_key, res in engines.items():
        ev = res.get("events") if isinstance(res, dict) else None
        if not isinstance(ev, dict):
            continue
        for name, fired in ev.items():
            if not fired:
                continue
            if eng_key == "bands" and (name.startswith("hit")
                                       or name == "strong"):
                # target hits follow the ladder direction; a 'strong'
                # grade follows the flip that fired with it
                d = res.get("dir", 0)
                if name == "strong":
                    d = 1 if ev.get("sig_buy") else -1
                side = "long" if d > 0 else ("short" if d < 0 else None)
            else:
                side = _event_side(name)
            rows.append({"sym": sym, "tf": tf, "engine": eng_key,
                         "event": name, "side": side})
    return rows


def atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    os.replace(tmp, path)


def _r2(v):
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return None


def screener_row(sym, rec):
    """Compact, filterable snapshot of one ticker for the search screener.

    scan.json is ~4 MB — far too heavy for a browser search surface — so the
    screener gets its own slim feed with just the fields worth filtering on.
    """
    row = {"sym": sym, "name": rec.get("name"),
           "mcap": rec.get("mcap"), "price": rec.get("price")}
    for tf in ("d", "w", "m"):
        eng = rec.get(tf) or {}
        b = eng.get("bands") or {}
        osc = (eng.get("osc") or {}).get("state") or {}
        if "error" in b or b.get("regime") not in ("bull", "bear"):
            continue
        row[tf] = {
            "regime": b.get("regime"),
            "age": b.get("regime_age"),
            "flip": bool(b.get("flipped_today")),
            "basis_pct": b.get("price_vs_basis_pct"),
            "vol_z": b.get("vol_z"),
            "hv": (b.get("hv") or {}).get("tag"),
            "noise": (b.get("noise") or {}).get("verdict"),
            "wave_side": osc.get("side"),
            "wave_rel": osc.get("wave_vs_signal"),
            "flow": osc.get("flow_side"),
            "conf": osc.get("confluence"),
            # Levels for the IQ Analyst page — every number an answer can
            # cite must exist in this feed. r2() keeps the payload slim.
            "close": _r2(b.get("close")),
            "floor": _r2(b.get("thresh_lower")),
            "ceiling": _r2(b.get("thresh_upper")),
            "regime_lo": _r2(b.get("run_low")),
            "regime_hi": _r2(b.get("run_high")),
            "swing_hi": _r2(b.get("prev_high")),
            "swing_lo": _r2(b.get("prev_low")),
            "trail": _r2(b.get("trail")),
        }
    d_struct = ((rec.get("d") or {}).get("structure") or {})
    fired = d_struct.get("events_fired") or []
    if fired:
        row["struct_events"] = fired
    return row


def main(argv=None):
    ap = argparse.ArgumentParser(description="IQ Algo universe scanner")
    ap.add_argument("--top", type=int,
                    default=int(os.environ.get("UNIVERSE_TOP", "500")),
                    help="keep top N tickers by mcap (default 500)")
    ap.add_argument("--symbols", default=None,
                    help="comma list debug subset, e.g. AAPL,MSFT "
                         "(bypasses universe + MIN_OK guard)")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "docs"),
        help="output docs dir (files land in <out>/iq/)")
    args = ap.parse_args(argv)

    rng = os.environ.get("BAR_RANGE", "2y")
    delay = float(os.environ.get("YAHOO_DELAY", "0.15"))
    min_ok = int(os.environ.get("MIN_OK", "100"))

    t0 = time.time()
    mcaps = fetch_mcaps()

    if args.symbols:
        syms = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
        universe_size = len(syms)
        min_ok = 1
    else:
        universe = fetch_universe()
        if not universe:
            print("FATAL: universe unavailable, aborting (previous output "
                  "kept)", file=sys.stderr)
            return 1
        universe_size = len(universe)
        syms = sorted(universe, key=lambda s: mcaps.get(s, 0.0),
                      reverse=True)[:args.top]
        print("universe %d tickers -> scanning top %d by mcap"
              % (universe_size, len(syms)))
        # a deliberately small --top run should still write its output;
        # the guard exists to catch mass fetch failures on big runs
        min_ok = min(min_ok, len(syms))

    now_utc = datetime.now(timezone.utc).date()
    cur_week, cur_month = _week_key(now_utc), _month_key(now_utc)

    tickers = {}
    events = []
    skipped = []
    for idx, sym in enumerate(syms):
        if idx:
            time.sleep(delay)
        fetched = fetch_daily(sym, rng, delay)
        if fetched is None:
            skipped.append(sym)
            continue
        name, dates, o, h, l, c, v = fetched

        rec = {"name": name,
               "mcap": round(mcaps.get(sym, 0.0), 3),
               "price": round(c[-1], 4),
               "bars_daily": len(c)}

        d_eng = run_engines(o, h, l, c, v, with_structure=True)
        rec["d"] = d_eng
        events += collect_events(sym, "d", d_eng)

        for tf, keyfn, drop_key in (("w", _week_key, cur_week),
                                    ("m", _month_key, cur_month)):
            ro, rh, rl, rc, rv = resample(dates, o, h, l, c, v,
                                          keyfn, drop_key)
            if len(rc) < 10:
                rec[tf] = {"error": "only %d confirmed bars" % len(rc)}
                continue
            eng = run_engines(ro, rh, rl, rc, rv, with_structure=False)
            rec[tf] = eng
            events += collect_events(sym, tf, eng)

        tickers[sym] = rec
        if (idx + 1) % LOG_EVERY == 0 or idx + 1 == len(syms):
            print("[%d/%d] %s  ok=%d skip=%d  %.0fs"
                  % (idx + 1, len(syms), sym, len(tickers), len(skipped),
                     time.time() - t0))

    if len(tickers) < min_ok:
        print("MIN_OK guard: only %d/%d tickers scanned (< %d) — NOT "
              "writing, previous output kept"
              % (len(tickers), len(syms), min_ok), file=sys.stderr)
        return 2

    out_dir = os.path.join(args.out, "iq")
    os.makedirs(out_dir, exist_ok=True)
    updated = _now_iso()
    scan_doc = {"updated_at": updated,
                "universe_size": universe_size,
                "scanned": len(tickers),
                "skipped": skipped,
                "bar_range": rng,
                "tickers": tickers}
    events_doc = {"updated_at": updated,
                  "count": len(events),
                  "events": events}
    screener_doc = {"updated_at": updated,
                    "count": len(tickers),
                    "rows": [screener_row(s, r)
                             for s, r in sorted(tickers.items())]}
    scan_path = os.path.join(out_dir, "scan.json")
    events_path = os.path.join(out_dir, "events.json")
    screener_path = os.path.join(out_dir, "screener.json")
    atomic_write(scan_path, scan_doc)
    atomic_write(events_path, events_doc)
    atomic_write(screener_path, screener_doc)
    print("wrote %s (%d tickers, %.1f KB) and %s (%d events) in %.0fs"
          % (scan_path, len(tickers),
             os.path.getsize(scan_path) / 1024.0,
             events_path, len(events), time.time() - t0))
    return 0


if __name__ == "__main__":
    sys.exit(main())
