#!/usr/bin/env python3
"""Index membership lists for the heatmap's Source menu.

Reads the constituents tables on Wikipedia (S&P 500, Nasdaq-100, Dow Jones
Industrial Average) with the standard library only, normalises tickers to
the dash form the feeds use (BRK.B -> BRK-B), and writes
    docs/iq/indexes.json  {updated_at, lists: {sp500|ndx100|dow30: {name, count, tickers}}}
    docs/iq/sp500.json    {updated_at, count, tickers}   (the existing consumer's shape)
A list that cannot be fetched, or comes back implausibly short, keeps its
previous contents; the scan never depends on this step.
"""
import html
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "docs", "iq")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")

# (name, page, header words that mark the ticker column, plausible minimum)
# The Nasdaq-100 article no longer carries its components table, so that
# list comes from stockanalysis.com; the Dow list moved to its own page.
SOURCES = {
    "sp500": ("S&P 500", "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", ("symbol", "ticker"), 480),
    "ndx100": ("Nasdaq 100", "https://stockanalysis.com/list/nasdaq-100-stocks/", ("symbol", "ticker"), 95),
    "dow30": ("Dow 30", "https://en.wikipedia.org/wiki/List_of_Dow_Jones_Industrial_Average_companies", ("symbol", "ticker"), 28),
}

TAG = re.compile(r"<[^>]+>")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def cell_text(cell):
    return html.unescape(TAG.sub("", cell)).replace("\xa0", " ").strip()


def constituents(page, header_names):
    """Ticker column of the first table whose header carries one of header_names."""
    for table in page.split("<table")[1:]:
        table = table.split("</table>")[0]
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table, flags=re.S | re.I)
        if len(rows) < 10:
            continue
        head = [cell_text(x).lower() for x in re.findall(r"<th[^>]*>(.*?)</th>", rows[0], flags=re.S | re.I)]
        col = next((i for i, h in enumerate(head) if h in header_names), None)
        if col is None:
            continue
        out = []
        for row in rows[1:]:
            # some tables put the company name in a <th scope="row">: read both cell kinds in order
            cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S | re.I)
            if len(cells) <= col:
                continue
            t = cell_text(cells[col]).upper().replace(".", "-")
            if re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", t):
                out.append(t)
        if out:
            return sorted(set(out))
    return []


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, "indexes.json")
    previous = {}
    if os.path.exists(path):
        try:
            previous = json.load(open(path)).get("lists", {})
        except Exception:
            previous = {}
    lists = {}
    for key, (name, url, headers, minimum) in SOURCES.items():
        try:
            tickers = constituents(fetch(url), headers)
        except Exception as e:  # network or parse: keep the last list
            print("%s: fetch failed (%s)" % (key, e), file=sys.stderr)
            tickers = []
        if len(tickers) < minimum:
            print("%s: only %d tickers, keeping the previous list" % (key, len(tickers)), file=sys.stderr)
            prev = previous.get(key, {}).get("tickers") or []
            tickers = prev
        lists[key] = {"name": name, "count": len(tickers), "tickers": tickers}
        print("%s: %d tickers" % (key, len(tickers)))
    if not any(v["count"] for v in lists.values()):
        print("no lists at all, not writing", file=sys.stderr)
        return 1
    updated = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"updated_at": updated, "lists": lists}, f, separators=(",", ":"))
    os.replace(tmp, path)
    if lists["sp500"]["count"]:
        sp = os.path.join(OUT_DIR, "sp500.json")
        with open(sp + ".tmp", "w") as f:
            json.dump({"updated_at": updated, "count": lists["sp500"]["count"], "tickers": lists["sp500"]["tickers"]}, f, separators=(",", ":"))
        os.replace(sp + ".tmp", sp)
    return 0


if __name__ == "__main__":
    sys.exit(main())
