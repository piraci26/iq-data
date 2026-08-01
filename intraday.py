#!/usr/bin/env python3
"""Triple-signal scanner: 30m + 2H intraday engines gated against the daily.

Reads the universe and fresh daily states from docs/iq/scan.json (written by
scanner.py in the same job), fetches 30-minute bars per ticker, resamples a
session-anchored 2-hour series from them, runs the IQ Bands + IQ Oscillator
engines on both, and emits docs/iq/signals.json containing ONLY tickers whose
bands regime agrees on all three clocks (30m, 2H, 1D). That triple alignment
is the product's definition of a signal — nothing else ships.

2H bars are anchored to each session's first 30m bar (TradingView-style), so
buckets run 9:30-11:30, 11:30-13:30, ... in exchange time regardless of DST.
"""

import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import _http_json, run_engines, atomic_write  # noqa: E402

YAHOO_30M = ("https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
             "?interval=30m&range=60d")
SCAN_PATH = os.environ.get("SCAN_PATH", "docs/iq/scan.json")
OUT_PATH = os.environ.get("SIGNALS_PATH", "docs/iq/signals.json")
FETCH_DELAY = float(os.environ.get("FETCH_DELAY", "0.15"))
MIN_30M_BARS = 120          # engines want 33-bar warm-up with headroom
FRESH_MAX_AGE = 2           # a leg that flipped within its last 2 bars = fresh


def fetch_30m(sym):
    """Confirmed 30m bars: (ts_epochs, o, h, l, c, v) or None."""
    url = YAHOO_30M.format(sym=urllib.request.quote(sym))
    try:
        data = _http_json(url)
        res = data["chart"]["result"][0]
        ts = res["timestamp"]
        q = res["indicators"]["quote"][0]
        oo, hh, ll, cc, vv = (q["open"], q["high"], q["low"],
                              q["close"], q["volume"])
    except Exception as e:
        print("  %s: 30m fetch failed (%s)" % (sym, e), file=sys.stderr)
        return None

    T, o, h, l, c, v = [], [], [], [], [], []
    for i in range(len(ts)):
        row = (oo[i], hh[i], ll[i], cc[i], vv[i])
        if any(x is None for x in row):
            continue
        T.append(int(ts[i]))
        o.append(float(row[0])); h.append(float(row[1]))
        l.append(float(row[2])); c.append(float(row[3]))
        v.append(float(row[4]))

    # confirmed-bar guard: the last 30m bucket may still be forming
    if T and time.time() < T[-1] + 1800:
        for s in (T, o, h, l, c, v):
            s.pop()
    if len(c) < MIN_30M_BARS:
        return None
    return T, o, h, l, c, v


def resample_2h(T, o, h, l, c, v):
    """Session-anchored 2H bars from 30m bars.

    Bars are grouped per trading day (a gap of >= 4h starts a new session)
    and bucketed by elapsed time since that session's first bar.
    """
    RO, RH, RL, RC, RV = [], [], [], [], []
    day_start = None
    cur_key = None
    for i in range(len(T)):
        if day_start is None or T[i] - T[i - 1] >= 4 * 3600:
            day_start = T[i]
        key = (day_start, (T[i] - day_start) // 7200)
        if key != cur_key:
            cur_key = key
            RO.append(o[i]); RH.append(h[i]); RL.append(l[i])
            RC.append(c[i]); RV.append(v[i])
        else:
            RH[-1] = max(RH[-1], h[i])
            RL[-1] = min(RL[-1], l[i])
            RC[-1] = c[i]
            RV[-1] += v[i]
    return RO, RH, RL, RC, RV


def tf_state(engines):
    """Compact per-timeframe cell for the feed."""
    b = engines.get("bands") or {}
    osc = (engines.get("osc") or {}).get("state") or {}
    if "error" in b or b.get("regime") not in ("bull", "bear"):
        return None
    return {
        "regime": b.get("regime"),
        "age": b.get("regime_age"),
        "flipped": bool(b.get("flipped_today")),
        "close": b.get("close"),
        "wave_side": osc.get("side"),
        "flow_side": osc.get("flow_side"),
        "confluence": osc.get("confluence"),
    }


def main(argv=None):
    try:
        with open(SCAN_PATH) as f:
            scan = json.load(f)
    except Exception as e:
        print("cannot read %s: %s" % (SCAN_PATH, e), file=sys.stderr)
        return 1
    tickers = scan.get("tickers") or {}
    syms = sorted(tickers.keys())
    limit = int(os.environ.get("SIGNALS_LIMIT", "0"))
    if limit:
        syms = syms[:limit]

    triples = []
    checked = 0
    failed = 0
    for sym in syms:
        tk = tickers[sym]
        d_bands = ((tk.get("d") or {}).get("bands")) or {}
        d_regime = d_bands.get("regime")
        if d_regime not in ("bull", "bear"):
            continue

        bars = fetch_30m(sym)
        time.sleep(FETCH_DELAY)
        if bars is None:
            failed += 1
            continue
        checked += 1
        T, o, h, l, c, v = bars

        m30 = tf_state(run_engines(o, h, l, c, v, with_structure=False))
        r2 = resample_2h(T, o, h, l, c, v)
        h2 = tf_state(run_engines(*r2, with_structure=False))
        if not m30 or not h2:
            continue

        # THE GATE: all three clocks on the same side, or the ticker is silent.
        if not (m30["regime"] == h2["regime"] == d_regime):
            continue

        youngest = min(
            ("30m", m30["age"] if m30["age"] is not None else 10 ** 9),
            ("2h", h2["age"] if h2["age"] is not None else 10 ** 9),
            ("1d", d_bands.get("regime_age") or 10 ** 9),
            key=lambda x: x[1],
        )
        triples.append({
            "sym": sym,
            "name": tk.get("name") or sym,
            "side": d_regime,
            "price": tk.get("price"),
            "fresh": youngest[1] <= FRESH_MAX_AGE,
            "youngest_tf": youngest[0],
            "youngest_age": youngest[1],
            "tfs": {
                "m30": m30,
                "h2": h2,
                "d": {
                    "regime": d_regime,
                    "age": d_bands.get("regime_age"),
                    "flipped": bool(d_bands.get("flipped_today")),
                },
            },
        })

    triples.sort(key=lambda t: (not t["fresh"], t["youngest_age"], t["sym"]))
    out = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "universe": len(syms),
        "checked": checked,
        "failed": failed,
        "count": len(triples),
        "bull": sum(1 for t in triples if t["side"] == "bull"),
        "bear": sum(1 for t in triples if t["side"] == "bear"),
        "triples": triples,
    }
    atomic_write(OUT_PATH, out)
    print("signals: %d triples (%d bull / %d bear) from %d checked, %d failed"
          % (out["count"], out["bull"], out["bear"], checked, failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
