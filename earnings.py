#!/usr/bin/env python3
"""Earnings calendar for the terminal's Earnings tool (owner, 2026-09-26: "a tool to the
right hand side strip ... like earnings calendar").

Nasdaq's public calendar, one request per weekday, DAYS_BACK behind today and
DAYS_AHEAD ahead (New York's today), every US-listed name (owner, 2026-09-27:
"missing a lot of names" — the universe filter is now opt-in), written atomically to
<out>/earn/earnings.json:

  {updated_at, today, days_back, days_ahead, universe_size, count, days_fetched,
   days_failed, failed_days: ["YYYY-MM-DD", ...],
   days: {"YYYY-MM-DD": [{sym, name, time, eps_est, eps_last, q, n_est, mcap_b, eps_act, surprise}, ...]},
   next: {SYM: {date, time, eps_est, eps_last, q, n_est}},   # first date on or after today
   last: {SYM: {date, time, eps_est, eps_last, q, eps_act, surprise}}}   # latest before today

eps_act is the EPS the company reported and surprise its distance from the estimate in
per cent (Nasdaq fills both once a report is out; owner, 2026-10-02: "can you do
estimate vs. reality"). The history behind the details panel is a second file,
<out>/earn/earnings_hist.json, kept incrementally (see update_history):

  {updated_at, from, fetched: ["YYYY-MM-DD", ...],
   sym: {SYM: [[date, quarter, estimate, actual, surprise], ...]}}   # newest first, 8 at most

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


def pct(s):
    """'5.67' -> 5.67, 'N/A' or '' -> None"""
    try:
        v = float(str(s).replace("%", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return v if v == v else None


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
            # Nasdaq repeats the year-ago EPS in `eps` until a new report is processed,
            # and only then fills `surprise` (2026-10-02: ACN's "Aug/2026 $3.03" and
            # NKE's "$0.49" were their Aug/2025 figures). A reported EPS is kept only
            # when the surprise is there; where it is, it matches Nasdaq's per-company
            # surprise table.
            "eps_act": money(r.get("eps")) if pct(r.get("surprise")) is not None else None,
            "surprise": pct(r.get("surprise")),
        })
    return out


HIST_DAYS = 400      # about four quarters of reports behind today
HIST_KEEP = 8        # reports kept per name


def update_history(days, today, out_root, back, pause):
    """Estimate vs actual per name, kept across runs in <out>/earn/earnings_hist.json.

    The days this run fetched (the last `back` days) are merged every time, since a
    report's actual can land a day late. Older weekdays inside HIST_DAYS are fetched
    once and remembered in `fetched`, so the first run backfills and later runs ask
    for nothing new."""
    path = os.path.join(out_root, "earn", "earnings_hist.json")
    try:
        with open(path) as f:
            hist = json.load(f)
    except (OSError, ValueError):
        hist = {}
    start = today - timedelta(days=HIST_DAYS)
    fetched = {d for d in hist.get("fetched", []) if d >= start.isoformat()}
    per = {s: {e[0]: e for e in v} for s, v in (hist.get("sym") or {}).items()}

    pool = {ds: rows for ds, rows in days.items() if ds < today.isoformat()}
    older_end = today - timedelta(days=back + 1)
    todo = [d for d in weekdays(start, 0, (older_end - start).days) if d.isoformat() not in fetched]
    got = 0
    for d in todo:
        try:
            pool[d.isoformat()] = fetch_day(d)
            fetched.add(d.isoformat())
            got += 1
        except Exception as e:
            print("history day %s failed: %s" % (d, e), file=sys.stderr)
        time.sleep(pause)

    for ds, rows in pool.items():
        for r in rows:
            if r.get("eps_act") is None:
                continue
            per.setdefault(r["sym"], {})[ds] = [ds, r.get("q"), r.get("eps_est"), r["eps_act"], r.get("surprise")]
    out = {}
    for s, by_date in per.items():
        keep = sorted((e for d, e in by_date.items() if d >= start.isoformat() and e[4] is not None),
                      key=lambda e: e[0], reverse=True)[:HIST_KEEP]
        if keep:
            out[s] = keep
    doc = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "from": start.isoformat(),
        "fetched": sorted(fetched),
        "sym": out,
    }
    atomic_write(path, doc)
    print("wrote %s: %d names, %d older days fetched this run" % (path, len(out), got))


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
    ap.add_argument("--no-history", action="store_true", help="skip earnings_hist.json")
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
                # later dates overwrite: the latest wins
                last[r["sym"]] = dict(rec, eps_act=r.get("eps_act"), surprise=r.get("surprise"))
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
    if not args.no_history:
        try:
            update_history(days, today, args.out, args.back, args.pause)
        except Exception as e:
            # the calendar is written; a history failure keeps yesterday's file
            print("history not updated: %s" % e, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
