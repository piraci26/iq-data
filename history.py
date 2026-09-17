#!/usr/bin/env python3
"""Chart history on its own clock: 1-minute sessions and daily years, from Alpaca.

Owner, 2026-09-17, looking at the charts: "the range on the chart is still
limited to 24h". Inside the scan job the history only moved when a 40-minute
run finished, and that job's commit replaces all of docs/iq with its own
snapshot, so this lives in a separate workflow writing docs/hist only.

docs/hist/bars_1m_days/SYM/YYYY-MM-DD.json  one finished regular session of
    1-minute rows [t, o, h, l, c, v]; SYM.json lists the newest SESSIONS_1M.
docs/hist/bars_1d_years/SYM/YYYY.json       daily rows since 2016 built from
    regular-session 30-minute bars (daily_history.py); SYM.json lists years.

The 1-minute coverage is the scan's live 1-minute set (docs/iq/bars_1m.json)
plus the index ETFs; the daily coverage is the scan universe plus the ETFs.
Each run fills what is missing, biggest names first, inside a time budget.
"""

import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import atomic_write  # noqa: E402
import alpaca  # noqa: E402

OUT = os.environ.get("HIST_DIR", "docs/hist")
DAYS_DIR = os.path.join(OUT, "bars_1m_days")
SESSIONS_1M = int(os.environ.get("SESSIONS_1M", "12"))
MIN_SESSION_BARS = 150
LIVE_INDEX = os.environ.get("BARS1M_PATH", "docs/iq/bars_1m.json")
SCAN_PATH = os.environ.get("SCAN_PATH", "docs/iq/scan.json")
ETFS = ["SPY", "QQQ", "IWM", "DIA", "VOO", "VTI"]
BUDGET_S = int(os.environ.get("HIST_BUDGET_S", str(25 * 60)))
STALE_DAYS = 14

os.environ.setdefault("DAILY_YEARS_DIR", os.path.join(OUT, "bars_1d_years"))
import daily_history  # noqa: E402  (reads DAILY_YEARS_DIR at import)


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


def _needs(m, day):
    """A session is fetched when the symbol lacks it and it is among the newest SESSIONS_1M it should keep."""
    have = m.get("days") or []
    if day in have or day in (m.get("empty") or []):
        return False
    return len(have) < SESSIONS_1M or day > min(have)


def sessions_1m(cover, deadline):
    """Write the finished sessions each covered symbol lacks, one request set per missing day."""
    os.makedirs(DAYS_DIR, exist_ok=True)
    now = daily_history._ny_now()
    closed = daily_history._closed(now)
    # a few extra weekdays so holidays still leave SESSIONS_1M sessions with bars
    days = alpaca.recent_weekdays(SESSIONS_1M + 4, include_today=closed)
    mans = {s: (_load(os.path.join(DAYS_DIR, "%s.json" % s), {}) or {}) for s in cover}
    written = 0
    for day in reversed(days):   # newest first: the charts need the latest sessions most
        if time.time() > deadline:
            break
        need = [s for s in cover if _needs(mans[s], day)]
        if not need:
            continue
        covered = set()
        start, end = alpaca.session_bounds(day)
        got = alpaca.bars(need, "1Min", start, end, covered=covered)
        if got is None:
            print("history: Alpaca refused; stopping the 1-minute sessions", file=sys.stderr)
            return written
        for sym in need:
            if sym not in covered:
                continue
            rows = got.get(sym) or []
            m = mans[sym]
            if len(rows) >= MIN_SESSION_BARS:
                os.makedirs(os.path.join(DAYS_DIR, sym), exist_ok=True)
                atomic_write(os.path.join(DAYS_DIR, sym, "%s.json" % day), rows)
                m["days"] = sorted(set(m.get("days") or []) | {day})
                written += 1
            else:
                # a holiday or a name that did not trade: remember, do not ask again
                m["empty"] = sorted(d for d in set(m.get("empty") or []) | {day} if d >= days[0])
    for sym, m in mans.items():
        have = sorted(m.get("days") or [])
        keep = have[-SESSIONS_1M:]
        for day in set(have) - set(keep):
            try:
                os.remove(os.path.join(DAYS_DIR, sym, "%s.json" % day))
            except OSError:
                pass
        if keep or m.get("empty"):
            new = {"days": keep, "empty": [d for d in (m.get("empty") or []) if d >= days[0]]}
            if new != _load(os.path.join(DAYS_DIR, "%s.json" % sym), None):
                atomic_write(os.path.join(DAYS_DIR, "%s.json" % sym), new)
    # a symbol out of coverage for a while goes
    cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - STALE_DAYS * 86400))
    for fn in os.listdir(DAYS_DIR):
        sym = fn[:-5] if fn.endswith(".json") else None
        if sym and sym not in mans:
            days_kept = (_load(os.path.join(DAYS_DIR, fn), {}) or {}).get("days") or []
            if not days_kept or days_kept[-1] < cutoff:
                shutil.rmtree(os.path.join(DAYS_DIR, sym), ignore_errors=True)
                os.remove(os.path.join(DAYS_DIR, fn))
    return written


def main():
    if not alpaca.enabled():
        print("history: no Alpaca keys, nothing to do")
        return 0
    t0 = time.time()
    deadline = t0 + BUDGET_S
    scan = _load(SCAN_PATH, {})
    tickers = scan.get("tickers") or {}
    mcap = lambda s: -((tickers.get(s) or {}).get("mcap") or 0)
    live = (_load(LIVE_INDEX, {}) or {}).get("syms") or []
    cover = ETFS + sorted((s for s in set(live) if s not in ETFS), key=mcap)
    n1 = sessions_1m(cover, deadline)
    print("history: %d one-minute session files written for %d symbols in %.0fs (%s)" % (n1, len(cover), time.time() - t0, alpaca.stats))
    # the daily years get whatever time is left
    daily_history.ALPACA_BACKFILL_PER_RUN = int(os.environ.get("DAILY_ALPACA_BACKFILL_PER_RUN", "150"))
    daily_history.main()
    print("history: done in %.0fs (%s)" % (time.time() - t0, alpaca.stats))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("history failed (%s)" % e, file=sys.stderr)
        sys.exit(0)
