#!/usr/bin/env python3
"""Economic calendar for the terminal's Economy tool (owner, 2026-10-02: "also please I
would like an economic calendar too, with numbers").

Nasdaq's public economic-events feed (the same source family as earnings.py), one
request per calendar day, --back days behind and --ahead days ahead of New York's
today, written atomically to <out>/earn/economic.json:

  {updated_at, today, days_back, days_ahead, count, days_fetched, days_failed,
   failed_days: ["YYYY-MM-DD", ...],
   days: {"YYYY-MM-DD": [{t, c, n, a, f, p}, ...]}}

t is "HH:MM" New York time (the feed labels it gmt, but it is Eastern: US jobless claims
sit at 08:30); c the country code; n the release; a actual, f consensus, p previous, as
the feed prints them ("254K", "0.3%"), null when blank.

THE FEED'S DATE IS ONE DAY AHEAD OF ITS EVENTS (checked 2026-10-02: Friday 2 Oct's
payrolls come back under the 3rd, Thursday 1 Oct's jobless claims and ISM under the 2nd,
Wednesday 7 Oct's FOMC minutes under the 8th), so day D is read from the feed's D + 1.
The feed's descriptions (which call a number bullish or bearish) are dropped.

Days the source refuses are retried once after a rest; the ones still missing are listed
in failed_days. A MIN_OK guard keeps the previous file when the source returns too little.
Pure stdlib. Exit codes: 0 ok, 2 MIN_OK guard, 3 nothing fetched."""

import argparse
import html
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from earnings import _http_json, atomic_write

NASDAQ = "https://api.nasdaq.com/api/calendar/economicevents?date="
NY = ZoneInfo("America/New_York")
# the feed's country names, as short codes; anything else keeps its name
COUNTRY = {
    "United States": "US", "Euro Zone": "EU", "Germany": "DE", "France": "FR", "Italy": "IT",
    "Spain": "ES", "United Kingdom": "GB", "Japan": "JP", "China": "CN", "Canada": "CA",
    "Australia": "AU", "New Zealand": "NZ", "Switzerland": "CH", "India": "IN",
    "South Korea": "KR", "Brazil": "BR", "Mexico": "MX", "Russia": "RU", "South Africa": "ZA",
    "Hong Kong": "HK", "Singapore": "SG", "Sweden": "SE", "Norway": "NO", "Turkey": "TR",
    "Netherlands": "NL", "Indonesia": "ID", "Taiwan": "TW", "Poland": "PL",
}


def clean(v):
    """the feed's value as printed, or None: '&nbsp;' and ' ' are blanks"""
    if v is None:
        return None
    s = html.unescape(str(v)).replace("\xa0", " ").strip()
    return s or None


def fetch_day(d):
    """the events OF day d, read from the feed's next day"""
    doc = _http_json(NASDAQ + (d + timedelta(days=1)).isoformat())
    rows = ((doc or {}).get("data") or {}).get("rows") or []
    out, seen = [], set()
    for r in rows:
        name = clean(r.get("eventName"))
        if not name:
            continue
        country = clean(r.get("country")) or ""
        ev = {
            "t": clean(r.get("gmt")) or "",
            "c": COUNTRY.get(country, country),
            "n": name,
            "a": clean(r.get("actual")),
            "f": clean(r.get("consensus")),
            "p": clean(r.get("previous")),
        }
        key = tuple(ev.values())
        if key in seen:
            continue
        seen.add(key)
        out.append(ev)
    out.sort(key=lambda e: (e["t"] or "99:99", e["c"] != "US", e["c"], e["n"]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Economic calendar from Nasdaq's public feed")
    ap.add_argument("--out", default="docs", help="output root (writes <out>/earn/economic.json)")
    ap.add_argument("--back", type=int, default=7, help="calendar days behind today")
    ap.add_argument("--ahead", type=int, default=21, help="calendar days ahead of today")
    ap.add_argument("--min-ok", type=int, default=200, help="fewer events than this keeps the previous file")
    ap.add_argument("--pause", type=float, default=0.8, help="seconds between requests")
    ap.add_argument("--rest", type=float, default=45.0, help="seconds before the second pass over refused days")
    args = ap.parse_args(argv)

    today = datetime.now(NY).date()
    todo = [today + timedelta(days=i) for i in range(-args.back, args.ahead + 1)]
    days, fetched, failed_days = {}, 0, []
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
            if rows:
                days[d.isoformat()] = rows
            time.sleep(args.pause)
        todo = failed_days
    if not fetched:
        print("FATAL: nothing fetched", file=sys.stderr)
        return 3
    total = sum(len(v) for v in days.values())
    out_path = os.path.join(args.out, "earn", "economic.json")
    if total < args.min_ok:
        print("MIN_OK guard: %d events < %d, keeping the previous file" % (total, args.min_ok), file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    doc = {
        "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": today.isoformat(),
        "days_back": args.back, "days_ahead": args.ahead,
        "count": total, "days_fetched": fetched, "days_failed": len(failed_days),
        "failed_days": [d.isoformat() for d in failed_days],
        "days": dict(sorted(days.items())),
    }
    atomic_write(out_path, doc)
    us = sum(1 for v in days.values() for e in v if e["c"] == "US")
    print("wrote %s: %d events (%d US) over %d days (%d failed)" % (out_path, total, us, len(days), len(failed_days)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
