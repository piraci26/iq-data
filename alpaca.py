#!/usr/bin/env python3
"""Alpaca market data, Basic (free) plan: consolidated-tape stock bars, 15 minutes delayed.

Owner, 2026-09-17: "go with alpaca free for now". The chart feeds (1m live,
1m sessions, 5m history) come from here; the engines' 30m bars and the daily
scan still come from Yahoo. Keys are the ALPACA_KEY_ID / ALPACA_SECRET_KEY
environment (GitHub secrets passed by the workflow). Without them, or when
Alpaca refuses the keys, bars() returns None and every caller keeps Yahoo.

The Basic plan serves SIP history back to 2016 but not the newest 15 minutes,
so every request ends 16 minutes ago, and allows 200 requests a minute. Rows
are the feeds' compact [t, o, h, l, c, v]: t = bar start in epoch seconds,
split-adjusted, regular New York session only (09:30-16:00), which is what
Yahoo's chart feed gave.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BARS_URL = "https://data.alpaca.markets/v2/stocks/bars"
DELAY_S = 16 * 60            # the free plan refuses the newest 15 minutes of SIP data
MIN_GAP_S = 60.0 / 180       # under the 200 requests a minute
CHUNK = 50                   # symbols per request

stats = {"requests": 0, "bars": 0, "groups_failed": 0}
_last_call = [0.0]
_refused = [False]           # 401/403 once: the keys are wrong, stop asking

try:
    from zoneinfo import ZoneInfo
    _NY = ZoneInfo("America/New_York")
except Exception:            # pragma: no cover
    _NY = None


def enabled():
    return bool(os.environ.get("ALPACA_KEY_ID", "").strip() and os.environ.get("ALPACA_SECRET_KEY", "").strip()) and not _refused[0]


def _regular(ts):
    d = datetime.fromtimestamp(ts, _NY) if _NY else datetime.utcfromtimestamp(ts - 4 * 3600)
    m = d.hour * 60 + d.minute
    return d.weekday() < 5 and 570 <= m < 960


def _get(params, timeout=40):
    wait = _last_call[0] + MIN_GAP_S - time.time()
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(BARS_URL + "?" + urllib.parse.urlencode(params), headers={
        "APCA-API-KEY-ID": os.environ.get("ALPACA_KEY_ID", "").strip(),
        "APCA-API-SECRET-KEY": os.environ.get("ALPACA_SECRET_KEY", "").strip(),
        "Accept": "application/json",
    })
    for attempt in range(3):
        _last_call[0] = time.time()
        stats["requests"] += 1
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:160]
            if e.code in (401, 403):
                _refused[0] = True
                raise RuntimeError("alpaca refused the request (%d): %s" % (e.code, body))
            if e.code == 429 and attempt < 2:
                time.sleep(10 * (attempt + 1))
                continue
            if attempt < 2 and e.code >= 500:
                time.sleep(3)
                continue
            raise RuntimeError("alpaca %d: %s" % (e.code, body))
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt < 2:
                time.sleep(3)
                continue
            raise RuntimeError("alpaca unreachable: %s" % e)


def _iso(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bars(symbols, timeframe, start_ts, end_ts=None, regular_only=True, covered=None):
    """{sym: rows} for the symbols Alpaca has bars for, or None when Alpaca is off or refuses the keys.

    A group that fails for another reason is left out (logged), so its symbols fall back to Yahoo;
    `covered`, when given, collects every symbol whose request went through (bars or not).
    """
    if not enabled():
        return None
    end_ts = min(end_ts or time.time(), time.time() - DELAY_S)
    out = {}
    syms = [s for s in symbols if s and s.replace(".", "").isalnum()]
    for i in range(0, len(syms), CHUNK):
        group = syms[i:i + CHUNK]
        got = {}
        token = None
        try:
            while True:
                params = {"symbols": ",".join(group), "timeframe": timeframe, "start": _iso(start_ts),
                          "end": _iso(end_ts), "limit": 10000, "adjustment": "split", "feed": "sip", "sort": "asc"}
                if token:
                    params["page_token"] = token
                data = _get(params) or {}
                for sym, rows in (data.get("bars") or {}).items():
                    stats["bars"] += len(rows)
                    dst = got.setdefault(sym, [])
                    for b in rows:
                        t = int(datetime.fromisoformat(b["t"].replace("Z", "+00:00")).timestamp())
                        if regular_only and not _regular(t):
                            continue
                        dst.append([t, round(float(b["o"]), 4), round(float(b["h"]), 4),
                                    round(float(b["l"]), 4), round(float(b["c"]), 4), int(b.get("v") or 0)])
                token = data.get("next_page_token")
                if not token:
                    break
        except Exception as e:
            if _refused[0]:
                print("alpaca: %s; Yahoo for everything this run" % e, file=sys.stderr)
                return None
            stats["groups_failed"] += 1
            print("alpaca: group %d failed (%s); those symbols fall back to Yahoo" % (i // CHUNK, e), file=sys.stderr)
            continue
        if covered is not None:
            covered.update(group)
        for sym, rows in got.items():
            if rows:
                rows.sort(key=lambda r: r[0])
                out[sym] = rows
    return out


def session_bounds(day):
    """09:30 to 16:00 New York on YYYY-MM-DD, as epoch seconds."""
    d = datetime.strptime(day, "%Y-%m-%d")
    return (int(datetime(d.year, d.month, d.day, 9, 30, tzinfo=_NY).timestamp()),
            int(datetime(d.year, d.month, d.day, 16, 0, tzinfo=_NY).timestamp()))


def recent_weekdays(n, include_today=True):
    """The newest n New York weekdays, oldest first. Holidays are in the list; they just return no bars."""
    d = datetime.now(_NY).date()
    if not include_today:
        d -= timedelta(days=1)
    days = []
    while len(days) < n:
        if d.weekday() < 5:
            days.append(d.strftime("%Y-%m-%d"))
        d -= timedelta(days=1)
    return days[::-1]


def session_bars(symbols, timeframe, days, covered=None):
    """{sym: rows} over whole regular sessions, one request set per day, so no pre- or post-market
    bars are ever downloaded. None when Alpaca is off or refuses the keys. `covered` gets only the
    symbols whose requests went through on every day asked."""
    if not enabled():
        return None
    out = {}
    remaining = list(symbols)
    now = time.time()
    for day in days:
        start, end = session_bounds(day)
        if start >= now - DELAY_S or not remaining:
            continue
        seen = set()
        res = bars(remaining, timeframe, start, end, covered=seen)
        if res is None:
            return None
        # a symbol whose request failed once is dropped from the later days: it falls back whole
        remaining = [s for s in remaining if s in seen]
        for sym, rows in res.items():
            if sym in seen:
                out.setdefault(sym, []).extend(rows)
    keep = set(remaining)
    out = {s: sorted(r, key=lambda x: x[0]) for s, r in out.items() if s in keep}
    if covered is not None:
        covered.update(keep)
    return out


if __name__ == "__main__":
    # smoke check on the runner: python alpaca.py NVDA
    sym = (sys.argv[1] if len(sys.argv) > 1 else "NVDA").upper()
    if not enabled():
        print("alpaca: no keys in the environment")
        sys.exit(1)
    now = time.time()
    for tf, days in (("1Min", 5), ("5Min", 90), ("1Day", 400)):
        res = bars([sym], tf, now - days * 86400, regular_only=tf != "1Day")
        rows = (res or {}).get(sym) or []
        first = datetime.fromtimestamp(rows[0][0], timezone.utc).isoformat() if rows else "-"
        last = datetime.fromtimestamp(rows[-1][0], timezone.utc).isoformat() if rows else "-"
        print("alpaca %s %s: %d bars, %s -> %s" % (sym, tf, len(rows), first, last))
    print("alpaca stats:", stats)
