#!/usr/bin/env python3
"""ETF and crypto heatmap feeds.

  docs/iq/etf.json     the largest US-listed ETFs by assets: symbol, name,
                       asset class, AUM ($B), price, 1-day change and the
                       same market-stats block the stock scan carries
  docs/iq/crypto.json  the top coins by market cap: symbol, name, market cap
                       ($B), price, 24h volume ($B) and the 1h/24h/7d/14d/30d/1y
                       changes

ETF universe and assets come from the stockanalysis.com ETF list; prices
from Yahoo's chart API (the scanner's helpers); coins from CoinGecko's
public markets endpoint. Either half failing keeps the previous file.
"""
import argparse
import html
import json
import os
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scanner import _http_json, atomic_write, market_stats  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
ETF_LIST_URL = "https://stockanalysis.com/etf/"
COINGECKO_URL = ("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd"
                 "&order=market_cap_desc&per_page=250&page=1"
                 "&price_change_percentage=1h,24h,7d,14d,30d,1y")
YAHOO_1Y = ("https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
            "?interval=1d&range=1y")
TAG = re.compile(r"<[^>]+>")

# stockanalysis asset classes -> the heatmap's groups (TradingView's names)
CLASS_MAP = {
    "equity": "Equity",
    "fixed income": "Fixed income",
    "bond": "Fixed income",
    "commodity": "Commodities",
    "commodities": "Commodities",
    "currency": "Currency",
    "alternative": "Alternatives",
    "alternatives": "Alternatives",
    "asset allocation": "Asset allocation",
    "multi-asset": "Asset allocation",
    "multi asset": "Asset allocation",
    "preferred stock": "Fixed income",
    "real estate": "Equity",
}


def fetch_text(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json,*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def cell_text(cell):
    return html.unescape(TAG.sub("", cell)).replace("\xa0", " ").strip()


def parse_money(s):
    """'$1.52T' / '$680.4B' / '$12.3M' -> USD billions."""
    m = re.match(r"^\$?\s*([\d.,]+)\s*([TBMK]?)$", s.strip().upper())
    if not m:
        return None
    n = float(m.group(1).replace(",", ""))
    unit = m.group(2)
    return n * {"T": 1000.0, "B": 1.0, "M": 0.001, "K": 0.000001, "": 1e-9}[unit]


def etf_universe():
    page = fetch_text(ETF_LIST_URL)
    for table in page.split("<table")[1:]:
        table = table.split("</table>")[0]
        rows = re.findall(r"<tr[^>]*>(.*?)</tr>", table, flags=re.S | re.I)
        if len(rows) < 50:
            continue
        head = [cell_text(x).lower() for x in re.findall(r"<th[^>]*>(.*?)</th>", rows[0], flags=re.S | re.I)]
        try:
            ci_sym = head.index("symbol")
            ci_name = head.index("fund name")
            ci_cls = head.index("asset class")
            ci_aum = head.index("assets")
        except ValueError:
            continue
        out = []
        for row in rows[1:]:
            cells = [cell_text(c) for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S | re.I)]
            if len(cells) <= max(ci_sym, ci_name, ci_cls, ci_aum):
                continue
            sym = cells[ci_sym].upper().replace(".", "-")
            aum = parse_money(cells[ci_aum])
            if not re.fullmatch(r"[A-Z]{1,5}(-[A-Z])?", sym) or not aum:
                continue
            raw_cls = cells[ci_cls].strip()
            out.append({"sym": sym, "name": cells[ci_name], "cls": CLASS_MAP.get(raw_cls.lower(), raw_cls or "Other"), "aum": round(aum, 3)})
        if out:
            out.sort(key=lambda r: -r["aum"])
            return out
    return []


def price_block(sym):
    """price, chg1d and the market stats from a year of daily bars."""
    data = _http_json(YAHOO_1Y.format(sym=urllib.request.quote(sym)))
    res = data["chart"]["result"][0]
    ts = res["timestamp"]
    q = res["indicators"]["quote"][0]
    dates, o, h, l, c, v = [], [], [], [], [], []
    for i in range(len(ts)):
        row = (q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i])
        if any(x is None for x in row):
            continue
        dates.append(datetime.fromtimestamp(ts[i], timezone.utc).date())
        o.append(float(row[0])); h.append(float(row[1])); l.append(float(row[2])); c.append(float(row[3])); v.append(float(row[4]))
    if len(c) < 2:
        return None
    return {"price": round(c[-1], 4),
            "chg1d": round((c[-1] / c[-2] - 1) * 100, 2) if c[-2] else None,
            "mkt": market_stats(dates, o, h, l, c, v)}


def build_etf(out_dir, top, delay):
    universe = etf_universe()
    if len(universe) < 50:
        print("etf: universe too small (%d), keeping the previous file" % len(universe), file=sys.stderr)
        return False
    rows = []
    t0 = time.time()
    for i, e in enumerate(universe[:top]):
        try:
            pb = price_block(e["sym"])
        except Exception as ex:
            print("  %s: %s" % (e["sym"], ex), file=sys.stderr)
            pb = None
        time.sleep(delay)
        if not pb:
            continue
        rows.append({**e, **pb})
        if (i + 1) % 100 == 0:
            print("[etf %d/%d] %.0fs" % (i + 1, min(top, len(universe)), time.time() - t0))
    if len(rows) < 50:
        print("etf: only %d priced, keeping the previous file" % len(rows), file=sys.stderr)
        return False
    atomic_write(os.path.join(out_dir, "etf.json"), {
        "updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "count": len(rows), "rows": rows})
    print("etf: %d funds, %d classes" % (len(rows), len({r["cls"] for r in rows})))
    return True


def build_crypto(out_dir):
    try:
        coins = json.loads(fetch_text(COINGECKO_URL))
    except Exception as ex:
        print("crypto: fetch failed (%s), keeping the previous file" % ex, file=sys.stderr)
        return False
    if not isinstance(coins, list) or len(coins) < 50:
        print("crypto: bad payload, keeping the previous file", file=sys.stderr)
        return False
    r2 = lambda x: None if x is None else round(float(x), 2)
    rows = []
    for c in coins:
        if not c.get("market_cap"):
            continue
        rows.append({
            "sym": str(c.get("symbol") or "").upper(),
            "name": c.get("name"),
            "id": c.get("id"),
            "mcap": round(float(c["market_cap"]) / 1e9, 3),
            "price": c.get("current_price"),
            "vol24": round(float(c.get("total_volume") or 0) / 1e9, 3),
            "chg": {"h1": r2(c.get("price_change_percentage_1h_in_currency")),
                    "d1": r2(c.get("price_change_percentage_24h_in_currency")),
                    "d7": r2(c.get("price_change_percentage_7d_in_currency")),
                    "d14": r2(c.get("price_change_percentage_14d_in_currency")),
                    "d30": r2(c.get("price_change_percentage_30d_in_currency")),
                    "y1": r2(c.get("price_change_percentage_1y_in_currency"))},
            "img": c.get("image"),
        })
    atomic_write(os.path.join(out_dir, "crypto.json"), {
        "updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "count": len(rows), "rows": rows})
    print("crypto: %d coins" % len(rows))
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description="ETF and crypto heatmap feeds")
    ap.add_argument("--out", default=os.path.join(HERE, "docs", "iq"))
    ap.add_argument("--etf-top", type=int, default=int(os.environ.get("ETF_TOP", "500")))
    ap.add_argument("--skip-etf", action="store_true")
    ap.add_argument("--skip-crypto", action="store_true")
    args = ap.parse_args(argv)
    os.makedirs(args.out, exist_ok=True)
    delay = float(os.environ.get("YAHOO_DELAY", "0.15"))
    ok = True
    if not args.skip_crypto:
        ok = build_crypto(args.out) and ok
    if not args.skip_etf:
        ok = build_etf(args.out, args.etf_top, delay) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
