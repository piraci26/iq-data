#!/usr/bin/env python3
"""Earnings calendar for the terminal's Earnings tool (owner, 2026-09-26: "a tool to the
right hand side strip ... like earnings calendar").

Nasdaq's public calendar, one request per weekday, DAYS_BACK behind today and
DAYS_AHEAD ahead (New York's today), every US-listed name (owner, 2026-09-27:
"missing a lot of names" — the universe filter is now opt-in), written atomically to
<out>/earn/earnings.json:

  {updated_at, today, days_back, days_ahead, universe_size, count, days_fetched,
   days_failed, failed_days: ["YYYY-MM-DD", ...],
   days: {"YYYY-MM-DD": [{sym, name, time, eps_est, eps_last, q, n_est, mcap_b}, ...]},
   next: {SYM: {date, time, eps_est, eps_last, q, n_est}},   # first date on or after today
   last: {SYM: {date, time, eps_est, eps_last, q}}}          # latest date before today

time is "pre" (before the open), "post" (after the close) or "na" (not supplied).
Days the source refuses are retried in a second pass after a rest; the ones still
missing are listed in failed_days. A MIN_OK guard keeps the previous file when the
source returns too little.
Pure stdlib. Exit codes: 0 ok, 2 MIN_OK guard, 3 nothing fetched."""

import argparse
import gzip
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

THT_BASE = "https://piraci26.github.io/tht-data"
NASDAQ = "https://api.nasdaq.com/api/calendar/earnings?date="
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
NY = ZoneInfo("America/New_York")


def _http_json(url, timeout=30, tries=5):
    last = None
    for attempt in range(tries):
        try:
            # gzip: a season day is ~110 KB chunked but ~18 KB with a length, and the
            # length-delimited body survives proxies that cut long chunked ones
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.9", "Referer": "https://www.nasdaq.com/",
                "Accept-Encoding": "gzip",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = r.read()
                if (r.headers.get("Content-Encoding") or "").lower() == "gzip":
                    body = gzip.decompress(body)
                return json.loads(body.decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as e:
            last = e
            time.sleep(2.0 * (attempt + 1) ** 2)   # 2, 8, 18, 32 s: the source throttles bursts
    raise RuntimeError("%s: %s" % (url, last))


def fetch_universe():
    """The tht-data universe (read-only), or None when it can't be read."""
    for path in ("/universe_filtered.json", "/universe.json"):
        try:
            data = _http_json(THT_BASE + path)
        except Exception as e:
            print("universe fetch failed %s: %s" % (path, e), file=sys.stderr)
            continue
        if isinstance(data, dict) and "tickers" in data:
            return set(data["tickers"])
        if isinstance(data, list):
            return set(x if isinstance(x, str) else x.get("ticker") for x in data if x)
    return None


def money(s):
    """'$1.36' -> 1.36, '($0.12)' -> -0.12, '' -> None"""
    if not s or not isinstance(s, str):
        return None
    t = s.strip().replace("$", "").replace(",", "")
    neg = t.startswith("(") and t.endswith(")")
    t = t.strip("()")
    try:
        v = float(t)
    except ValueError:
        return None
    return -v if neg else v


def mcap_b(s):
    v = money(s)
    return round(v / 1e9, 2) if v is not None and v > 0 else None


def when(t):
    t = (t or "").lower()
    if "pre" in t:
        return "pre"
    if "after" in t or "post" in t:
        return "post"
    return "na"


def weekdays(start, n_back, n_ahead):
    d = start - timedelta(days=n_back)
    end = start + timedelta(days=n_ahead)
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def fetch_day(d):
    doc = _http_json(NASDAQ + d.isoformat())
    rows = ((doc or {}).get("data") or {}).get("rows") or []
    out = []
    for r in rows:
        sym = (r.get("symbol") or "").strip().upper()
        if not sym:
            continue
        out.append({
            "sym": sym,
            "name": (r.get("name") or "").strip() or None,
            "time": when(r.get("time")),
            "eps_est": money(r.get("epsForecast")),
            "eps_last": money(r.get("lastYearEPS")),
            "q": (r.get("fiscalQuarterEnding") or "").strip() or None,
            "n_est": int(r["noOfEsts"]) if str(r.get("noOfEsts") or "").isdigit() else None,
            "mcap_b": mcap_b(r.get("marketCap")),
        })
    return out


def atomic_write(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, separators=(",", ":"), allow_nan=False)
    os.replace(tmp, path)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Earnings calendar from Nasdaq's public feed")
    ap.add_argument("--out", default="docs", help="output root (writes <out>/earn/earnings.json)")
    ap.add_argument("--back", type=int, default=100, help="calendar days behind today")
    ap.add_argument("--ahead", type=int, default=75, help="calendar days ahead of today")
    ap.add_argument("--min-ok", type=int, default=800, help="fewer rows than this keeps the previous file")
    ap.add_argument("--pause", type=float, default=0.8, help="seconds between requests")
    ap.add_argument("--rest", type=float, default=45.0, help="seconds before the second pass over refused days")
    ap.add_argument("--universe-only", action="store_true", help="keep only the tht-data universe's names")
    args = ap.parse_args(argv)

    today = datetime.now(NY).date()
    universe = fetch_universe() if args.universe_only else None
    if args.universe_only and universe is None:
        print("universe unavailable: keeping every name", file=sys.stderr)

    days = {}
    fetched = 0
    todo = list(weekdays(today, args.back, args.ahead))
    failed_days = []
    for attempt in range(2):
        if attempt:
            if not todo:
                break
            print("second pass over %d refused days after %.0fs" % (len(todo), args.rest), file=sys.stderr)
            time.sleep(args.rest)
        failed_days = []
        for d in todo:
            try:
                rows = fetch_day(d)
                fetched += 1
            except Exception as e:
                failed_days.append(d)
                print("day %s failed: %s" % (d, e), file=sys.stderr)
                continue
            if universe:
                rows = [r for r in rows if r["sym"] in universe]
            rows.sort(key=lambda r: -(r["mcap_b"] or 0))
            if rows:
                days[d.isoformat()] = rows
            time.sleep(args.pause)
        todo = failed_days
    failed = len(failed_days)
    if not fetched:
        print("FATAL: nothing fetched", file=sys.stderr)
        return 3

    nxt, last = {}, {}
    for ds in sorted(days):
        for r in days[ds]:
            rec = {"date": ds, "time": r["time"], "eps_est": r["eps_est"], "eps_last": r["eps_last"], "q": r["q"]}
            if ds >= today.isoformat():
                if r["sym"] not in nxt:
                    nxt[r["sym"]] = dict(rec, n_est=r["n_est"])
            else:
                last[r["sym"]] = rec          # later dates overwrite: the latest wins
    total = sum(len(v) for v in days.values())
    out_path = os.path.join(args.out, "earn", "earnings.json")
    if total < args.min_ok:
        print("MIN_OK guard: %d rows < %d, keeping the previous file" % (total, args.min_ok), file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    doc = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "days_back": args.back, "days_ahead": args.ahead,
        "universe_size": len(universe) if universe else None,
        "count": total, "days_fetched": fetched, "days_failed": failed,
        "failed_days": [d.isoformat() for d in failed_days],
        "days": days, "next": nxt, "last": last,
    }
    atomic_write(out_path, doc)
    print("wrote %s: %d rows over %d days (%d failed), next for %d names, last for %d"
          % (out_path, total, len(days), failed, len(nxt), len(last)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
