#!/usr/bin/env python3
"""Deep daily history for the charts, one file per calendar year, from 2016.

Owner, 2026-09-17, on the Backtest and Pine copilot charts: "2 weeks to the
left, minimum, for a 1-minute chart and then an equivalent amount of bars for
other timeframes"; then, on the source: "we can skip 2016 and older, but
indexes no". So:

- stocks and ETFs come from Alpaca (the free plan's consolidated-tape history
  starts in 2016). Alpaca's own daily bars include pre- and post-market trades,
  so each day is built from its regular-session 30-minute bars instead: open of
  the first, high and low over the session, close of the last, volume summed.
- no indices (owner: "let's do ETFs no indexes"): SPX, NDX and the rest are
  calculated values Alpaca does not carry, so the charts use the index ETFs
  (SPY, QQQ, IWM, DIA, VOO, VTI) instead and nothing here asks Yahoo.
- without Alpaca keys, stocks and ETFs fall back to Yahoo.

docs/iq/bars_1d_years/SYM/YYYY.json holds that year's confirmed daily rows
[t, o, h, l, c, v] (t = 09:30 New York on the day, split-adjusted prices);
docs/iq/bars_1d_years/SYM.json lists the years and the source. Past years
never change, so the Pages repo only rewrites the current year once a day. A
split re-adjusts the whole history: when stored closes no longer match a fresh
fetch the symbol is marked for a full rebuild on the next run.

Backfill runs a batch of symbols a run, the markets and biggest names first;
after the New York close every symbol is refreshed once. Never fatal: the
workflow step continues on error.
"""

import json
import os
import shutil
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import _http_json, atomic_write  # noqa: E402
import alpaca  # noqa: E402

SCAN_PATH = os.environ.get("SCAN_PATH", "docs/iq/scan.json")
DIR = os.environ.get("DAILY_YEARS_DIR", "docs/iq/bars_1d_years")
SINCE = os.environ.get("DAILY_SINCE", "2016-01-01")
ALPACA_BACKFILL_PER_RUN = int(os.environ.get("DAILY_ALPACA_BACKFILL_PER_RUN", "100"))
ALPACA_GROUP = 25            # symbols per history request set: ten years of 30-minute bars is a lot of rows
YAHOO_BACKFILL_PER_RUN = int(os.environ.get("DAILY_BACKFILL_PER_RUN", "250"))
FETCH_DELAY = float(os.environ.get("FETCH_DELAY", "0.15"))
YAHOO_1D = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range={rng}"
# no indices (owner, 2026-09-17: "let's do ETFs no indexes"); kept as an empty map so the Yahoo path stays generic
INDICES = {}
MARKET_ETFS = ["SPY", "QQQ", "IWM", "DIA", "VOO", "VTI"]
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


def _since_ts():
    return int(datetime.strptime(SINCE, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def _closed(now):
    return (now.hour, now.minute) >= (16, 35) or now.weekday() >= 5


def fetch_yahoo_daily(ysym, rng):
    """Confirmed daily rows from Yahoo since SINCE, oldest first, or None."""
    url = YAHOO_1D.format(sym=urllib.request.quote(ysym), rng=rng)
    try:
        res = _http_json(url, timeout=30)["chart"]["result"][0]
        ts = res.get("timestamp") or []
        q = res["indicators"]["quote"][0]
    except Exception as e:
        print("  %s: daily fetch failed (%s)" % (ysym, e), file=sys.stderr)
        return None
    oo, hh, ll, cc, vv = (q.get(k) or [] for k in ("open", "high", "low", "close", "volume"))
    now = _ny_now()
    today, closed, since = now.strftime("%Y-%m-%d"), _closed(now), _since_ts()
    rows = []
    for i in range(min(len(ts), len(oo), len(hh), len(ll), len(cc))):
        if None in (oo[i], hh[i], ll[i], cc[i]):
            continue
        t = int(ts[i])
        if t < since or (_ny_date(t) == today and not closed):
            continue
        v = vv[i] if i < len(vv) and vv[i] is not None else 0
        rows.append([t, round(float(oo[i]), 4), round(float(hh[i]), 4), round(float(ll[i]), 4), round(float(cc[i]), 4), int(v)])
    return rows or None


def daily_from_session(rows):
    """Regular-session daily bars from 30-minute rows (already regular hours only), stamped 09:30 New York."""
    now = _ny_now()
    today, closed = now.strftime("%Y-%m-%d"), _closed(now)
    by_day = {}
    for r in rows:
        by_day.setdefault(_ny_date(r[0]), []).append(r)
    out = []
    for day in sorted(by_day):
        if day == today and not closed:
            continue
        rs = sorted(by_day[day], key=lambda x: x[0])
        out.append([alpaca.session_bounds(day)[0], rs[0][1], round(max(x[2] for x in rs), 4),
                    round(min(x[3] for x in rs), 4), rs[-1][4], int(sum(x[5] for x in rs))])
    return out


def _load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return default


def _write_years(sym, rows):
    """Merge these rows into their year files (a refresh covers only a few days, so what is stored
    stays and the fetched days update it); returns (files changed, years touched)."""
    by_year = {}
    for r in rows:
        by_year.setdefault(_ny_date(r[0])[:4], []).append(r)
    d = os.path.join(DIR, sym)
    os.makedirs(d, exist_ok=True)
    changed = 0
    for year, yr in by_year.items():
        path = os.path.join(d, "%s.json" % year)
        old = _load(path, [])
        merged = {_ny_date(r[0]): r for r in old}
        for r in yr:
            merged[_ny_date(r[0])] = r
        out = [merged[k] for k in sorted(merged)]
        if out != old:
            atomic_write(path, out)
            changed += 1
    return changed, sorted(by_year)


def _save(sym, man, years, source, today, after_close):
    first_year = SINCE[:4]
    d = os.path.join(DIR, sym)
    for y in [y for y in years if y < first_year]:
        try:
            os.remove(os.path.join(d, "%s.json" % y))
        except OSError:
            pass
    kept = sorted(y for y in set(years) if y >= first_year and os.path.exists(os.path.join(d, "%s.json" % y)))
    atomic_write(os.path.join(DIR, "%s.json" % sym), {
        "years": kept, "backfilled": True, "source": source,
        "checked": today if after_close else man.get("checked"),
    })


def _stale(sym, fresh_rows):
    """True when stored closes disagree with freshly fetched ones: a split re-adjusted the history."""
    stored = {}
    for year in {_ny_date(r[0])[:4] for r in fresh_rows}:
        for r in _load(os.path.join(DIR, sym, "%s.json" % year), []):
            stored[_ny_date(r[0])] = r
    for r in fresh_rows:
        s = stored.get(_ny_date(r[0]))
        if s and r[4] and abs(s[4] / r[4] - 1) > MISMATCH:
            return True
    return False


def main():
    scan = _load(SCAN_PATH, {})
    tickers = scan.get("tickers") or {}
    # the markets and the biggest names first: they are the ones charted most
    stocks = sorted(tickers, key=lambda s: -((tickers.get(s) or {}).get("mcap") or 0))
    universe = list(INDICES) + MARKET_ETFS + [s for s in stocks if s not in INDICES and s not in MARKET_ETFS]
    os.makedirs(DIR, exist_ok=True)
    now = _ny_now()
    today, after_close = now.strftime("%Y-%m-%d"), _closed(now)
    use_alpaca = alpaca.enabled()
    manifests = {s: (_load(os.path.join(DIR, "%s.json" % s), {}) or {}) for s in universe}
    stats = {"backfilled": 0, "refreshed": 0, "marked": 0, "failed": 0, "files": 0}

    def wants_backfill(sym):
        m = manifests[sym]
        if not m.get("backfilled"):
            return True
        # the first version stored Yahoo history for stocks: rebuild those from Alpaca
        return use_alpaca and sym not in INDICES and m.get("source") != "alpaca"

    # 1. Alpaca: stocks and ETFs, the whole history since SINCE for a batch, then the last days for the rest
    if use_alpaca:
        pending = [s for s in universe if s not in INDICES and wants_backfill(s)][:ALPACA_BACKFILL_PER_RUN]
        for i in range(0, len(pending), ALPACA_GROUP):
            group = pending[i:i + ALPACA_GROUP]
            covered = set()
            try:
                got = alpaca.bars(group, "30Min", _since_ts(), covered=covered)
            except Exception as e:
                print("  alpaca daily history group failed (%s)" % e, file=sys.stderr)
                got = None
            if got is None:
                break
            for sym in group:
                days = daily_from_session(got.get(sym) or []) if sym in covered else []
                if len(days) < 2:
                    stats["failed"] += 1
                    continue
                shutil.rmtree(os.path.join(DIR, sym), ignore_errors=True)
                changed, years = _write_years(sym, days)
                stats["files"] += changed
                _save(sym, manifests[sym], years, "alpaca", today, after_close)
                manifests[sym] = _load(os.path.join(DIR, "%s.json" % sym), {})
                stats["backfilled"] += 1
        if after_close:
            due = [s for s in universe if s not in INDICES and manifests[s].get("source") == "alpaca"
                   and manifests[s].get("backfilled") and manifests[s].get("checked") != today]
            covered = set()
            got = None
            if due:
                try:
                    got = alpaca.bars(due, "30Min", int(time.time()) - 8 * 86400, covered=covered)
                except Exception as e:
                    print("  alpaca daily refresh failed (%s)" % e, file=sys.stderr)
            for sym in (due if got is not None else []):
                days = daily_from_session(got.get(sym) or []) if sym in covered else []
                if not days:
                    continue
                if _stale(sym, days):
                    atomic_write(os.path.join(DIR, "%s.json" % sym), dict(manifests[sym], backfilled=False))
                    stats["marked"] += 1
                    continue
                changed, years = _write_years(sym, days)
                stats["files"] += changed
                _save(sym, manifests[sym], sorted(set(manifests[sym].get("years") or []) | set(years)), "alpaca", today, after_close)
                stats["refreshed"] += 1

    # 2. Yahoo: the indices always; everything when Alpaca is not configured
    streak = attempts = 0
    for sym in universe:
        if use_alpaca and sym not in INDICES:
            continue
        if streak >= 10:
            break
        ysym = INDICES.get(sym, sym.replace(".", "-"))
        man = manifests[sym]
        if not man.get("backfilled"):
            if attempts >= YAHOO_BACKFILL_PER_RUN:
                continue
            attempts += 1
            rows = fetch_yahoo_daily(ysym, "max")
            time.sleep(FETCH_DELAY)
            if not rows:
                stats["failed"] += 1
                streak += 1
                continue
            streak = 0
            shutil.rmtree(os.path.join(DIR, sym), ignore_errors=True)
            changed, years = _write_years(sym, rows)
            stats["files"] += changed
            _save(sym, man, years, "yahoo", today, after_close)
            stats["backfilled"] += 1
        elif after_close and man.get("checked") != today:
            rows = fetch_yahoo_daily(ysym, "1mo")
            time.sleep(FETCH_DELAY)
            if not rows:
                stats["failed"] += 1
                streak += 1
                continue
            streak = 0
            if _stale(sym, rows):
                atomic_write(os.path.join(DIR, "%s.json" % sym), dict(man, backfilled=False))
                stats["marked"] += 1
                continue
            changed, years = _write_years(sym, rows)
            stats["files"] += changed
            _save(sym, man, sorted(set(man.get("years") or []) | set(years)), "yahoo", today, after_close)
            stats["refreshed"] += 1

    print("daily history (since %s, %s): %d backfilled, %d refreshed, %d marked for a rebuild after a re-adjustment, "
          "%d failed, %d year files written"
          % (SINCE, "Alpaca" if use_alpaca else "Yahoo, no Alpaca keys",
             stats["backfilled"], stats["refreshed"], stats["marked"], stats["failed"], stats["files"]))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never break the pipeline
        print("daily history skipped (%s)" % e, file=sys.stderr)
        sys.exit(0)
