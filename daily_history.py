#!/usr/bin/env python3
"""Deep daily history for the charts, one file per calendar year.

Owner, 2026-09-17, on the Backtest and Pine copilot charts: "2 weeks to the
left, minimum, for a 1-minute chart and then an equivalent amount of bars for
other timeframes". Two weeks of 1-minute bars is ~3,900; the charts get about
KEEP_BARS on every timeframe (12 sessions of 1m, 60 of 5m, and here roughly
18 years of daily bars; weekly bars are resampled from these in the client).

docs/iq/bars_1d_years/SYM/YYYY.json holds that year's confirmed daily rows
[t, o, h, l, c, v] (t = Yahoo's session timestamp, split-adjusted prices);
docs/iq/bars_1d_years/SYM.json lists the years kept. Past years never change,
so the Pages repo only rewrites the current year once a day. A split re-adjusts
the whole history: when the stored rows no longer match a fresh fetch, the
symbol is fetched again in full and every year rewritten.

A symbol without history is backfilled in full (BACKFILL_PER_RUN a run, the
biggest names first). After the New York close each symbol is refreshed once
a day. Never fatal: the workflow step continues on error.
"""

import json
import os
import shutil
import sys
import time
import urllib.request
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import _http_json, atomic_write  # noqa: E402

SCAN_PATH = os.environ.get("SCAN_PATH", "docs/iq/scan.json")
DIR = os.environ.get("DAILY_YEARS_DIR", "docs/iq/bars_1d_years")
KEEP_BARS = int(os.environ.get("DAILY_KEEP_BARS", "4700"))
BACKFILL_PER_RUN = int(os.environ.get("DAILY_BACKFILL_PER_RUN", "250"))
# the once-a-day refresh is spread over the evening runs so no run nears the job timeout
REFRESH_PER_RUN = int(os.environ.get("DAILY_REFRESH_PER_RUN", "400"))
FETCH_DELAY = float(os.environ.get("FETCH_DELAY", "0.15"))
YAHOO_1D = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range={rng}"
# our names for the markets the scan covers, as Yahoo spells them (tht-data markets.py)
MARKETS = {
    "SPX": "^GSPC", "NDX": "^NDX", "DJI": "^DJI", "RUT": "^RUT", "IXIC": "^IXIC", "VIX": "^VIX",
    "SPY": "SPY", "QQQ": "QQQ", "IWM": "IWM", "DIA": "DIA", "VOO": "VOO", "VTI": "VTI",
    "UKX": "^FTSE", "DAX": "^GDAXI", "CAC": "^FCHI", "SX5E": "^STOXX50E", "NI225": "^N225",
    "HSI": "^HSI", "NIFTY": "^NSEI", "TSX": "^GSPTSE",
}
MISMATCH = 0.005             # a close off by more than 0.5% means the history was re-adjusted


def _ny_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("America/New_York"))
    except Exception:
        return datetime.utcnow() - timedelta(hours=4)


def _ny_date(ts):
    try:
        from zoneinfo import ZoneInfo
        return datetime.fromtimestamp(ts, ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
    except Exception:
        return datetime.utcfromtimestamp(ts - 4 * 3600).strftime("%Y-%m-%d")


def fetch_daily(sym, rng):
    """Confirmed daily rows for a Yahoo symbol, oldest first, or None."""
    url = YAHOO_1D.format(sym=urllib.request.quote(sym), rng=rng)
    try:
        res = _http_json(url, timeout=30)["chart"]["result"][0]
        ts = res.get("timestamp") or []
        q = res["indicators"]["quote"][0]
    except Exception as e:
        print("  %s: daily fetch failed (%s)" % (sym, e), file=sys.stderr)
        return None
    oo, hh, ll, cc, vv = (q.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    now = _ny_now()
    today = now.strftime("%Y-%m-%d")
    closed = (now.hour, now.minute) >= (16, 35) or now.weekday() >= 5
    rows = []
    for i in range(min(len(ts), len(oo), len(hh), len(ll), len(cc))):
        if None in (oo[i], hh[i], ll[i], cc[i]):
            continue
        t = int(ts[i])
        if _ny_date(t) == today and not closed:
            continue   # today's bar is still forming
        v = vv[i] if i < len(vv) and vv[i] is not None else 0
        rows.append([t, round(float(oo[i]), 4), round(float(hh[i]), 4), round(float(ll[i]), 4), round(float(cc[i]), 4), int(v)])
    return rows or None


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


def _write_years(sym, rows):
    """Merge these rows into their year files (a refresh covers only part of the previous year, so
    what is stored stays and the fetched rows update it); returns (files changed, years touched)."""
    by_year = {}
    for r in rows:
        by_year.setdefault(_ny_date(r[0])[:4], []).append(r)
    d = os.path.join(DIR, sym)
    os.makedirs(d, exist_ok=True)
    changed = 0
    for year, yr in by_year.items():
        path = os.path.join(d, "%s.json" % year)
        old = _load(path, [])
        merged = {r[0]: r for r in old}
        for r in yr:
            merged[r[0]] = r
        out = [merged[t] for t in sorted(merged)]
        if out != old:
            atomic_write(path, out)
            changed += 1
    return changed, sorted(by_year)


def _trim(sym, years):
    """Keep the newest years that hold at least KEEP_BARS rows."""
    d = os.path.join(DIR, sym)
    kept, total = [], 0
    for year in sorted(years, reverse=True):
        kept.append(year)
        total += len(_load(os.path.join(d, "%s.json" % year), []))
        if total >= KEEP_BARS:
            break
    for year in set(years) - set(kept):
        try:
            os.remove(os.path.join(d, "%s.json" % year))
        except OSError:
            pass
    return sorted(kept)


def main():
    scan = _load(SCAN_PATH, {})
    tickers = scan.get("tickers") or {}
    # the biggest names first: they are the ones charted most
    stocks = sorted(tickers, key=lambda s: -((tickers.get(s) or {}).get("mcap") or 0))
    universe = list(MARKETS) + [s for s in stocks if s not in MARKETS]
    os.makedirs(DIR, exist_ok=True)
    now = _ny_now()
    today = now.strftime("%Y-%m-%d")
    after_close = (now.hour, now.minute) >= (16, 35) or now.weekday() >= 5
    backfilled = refreshed = rebuilt = failed = files = attempts = 0
    streak = 0   # failures in a row: ten means Yahoo is refusing, stop asking this run
    for sym in universe:
        ysym = MARKETS.get(sym, sym.replace(".", "-"))
        man_path = os.path.join(DIR, "%s.json" % sym)
        man = _load(man_path, {}) or {}
        years = man.get("years") or []
        rows = None
        if streak >= 10:
            break
        if not man.get("backfilled"):
            if attempts >= BACKFILL_PER_RUN:
                continue
            attempts += 1
            rows = fetch_daily(ysym, "max")
            time.sleep(FETCH_DELAY)
            if not rows:
                failed += 1
                streak += 1
                continue
            streak = 0
            rows = rows[-(KEEP_BARS + 260):]
            backfilled += 1
        elif after_close and man.get("checked") != today and refreshed + rebuilt < REFRESH_PER_RUN:
            recent = fetch_daily(ysym, "1y")
            time.sleep(FETCH_DELAY)
            if not recent:
                failed += 1
                streak += 1
                continue
            streak = 0
            stored = {}
            for year in {_ny_date(recent[0][0])[:4], _ny_date(recent[-1][0])[:4]}:
                for r in _load(os.path.join(DIR, sym, "%s.json" % year), []):
                    stored[r[0]] = r
            off = [r for r in recent if r[0] in stored and abs(stored[r[0]][4] / r[4] - 1) > MISMATCH] if stored else []
            if off:
                # a split or dividend re-adjustment: everything stored is on the old scale
                full = fetch_daily(ysym, "max")
                time.sleep(FETCH_DELAY)
                if not full:
                    failed += 1
                    continue
                shutil.rmtree(os.path.join(DIR, sym), ignore_errors=True)
                years = []
                rows = full[-(KEEP_BARS + 260):]
                rebuilt += 1
            else:
                rows = recent
                refreshed += 1
        else:
            continue
        changed, touched = _write_years(sym, rows)
        files += changed
        kept = _trim(sym, sorted(set(years) | set(touched)))
        atomic_write(man_path, {"years": kept, "backfilled": True, "checked": today if after_close else man.get("checked")})
    print("daily history: %d backfilled, %d refreshed, %d rebuilt after a re-adjustment, %d failed, %d year files written"
          % (backfilled, refreshed, rebuilt, failed, files))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never break the pipeline
        print("daily history skipped (%s)" % e, file=sys.stderr)
        sys.exit(0)
