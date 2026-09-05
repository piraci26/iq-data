#!/usr/bin/env python3
"""Company logos for the stock and ETF heatmaps.

For every symbol in docs/iq/screener.json and docs/iq/etf.json that has no
file under docs/logos/ yet, fetch a square PNG (nvstly/icons via jsDelivr,
then FMP, then Parqet), keep it only when it is at least 100px, and record
it in docs/iq/logos.json {updated_at, count, syms: {SYM: [w, h, light]}}.
`light` is 1 when the mark itself is light (a white glyph on a transparent
background, drawn for dark surfaces) so the heatmap can put it on a dark
disc instead of a white one. Existing files are never re-fetched, so a run
costs only the new names; the light flag is filled in for any entry missing it.
"""
import json
import os
import struct
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "docs", "logos")
MANIFEST = os.path.join(HERE, "docs", "iq", "logos.json")
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
SOURCES = [
    lambda s: "https://cdn.jsdelivr.net/gh/nvstly/icons@main/ticker_icons/%s.png" % s.replace("-", "."),
    lambda s: "https://cdn.jsdelivr.net/gh/nvstly/icons@main/ticker_icons/%s.png" % s,
    lambda s: "https://financialmodelingprep.com/image-stock/%s.png" % s,
    lambda s: "https://assets.parqet.com/logos/symbol/%s?format=png&size=256" % s,
]
MIN_PX = 100


def mark_is_light(path):
    """1 when the visible mark is light (mean luminance of opaque pixels above 0.7
    with a mostly transparent canvas), 0 otherwise, None without Pillow."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        im = Image.open(path).convert("RGBA")
    except Exception:
        return None
    px = im.getdata()
    opaque = [(r, g, b) for r, g, b, a in px if a > 128]
    if not opaque:
        return 0
    transparent_share = 1 - len(opaque) / max(1, len(px))
    lum = sum(0.2126 * r + 0.7152 * g + 0.0722 * b for r, g, b in opaque) / (255 * len(opaque))
    return 1 if (transparent_share > 0.3 and lum > 0.7) else 0


def normalise(path):
    """Trim the transparent margin around the mark, then place it on a square
    canvas so its centre of mass (not its bounding box) sits in the middle:
    asymmetric marks (an eye, a slanted M, a script L) look balanced in a
    disc only when centred optically. The shift is capped at 5%% of the
    canvas so nothing is cut. Full-bleed images (no transparency) are left
    as they are. Returns (w, h) of the written file, or None without Pillow."""
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        im = Image.open(path).convert("RGBA")
    except Exception:
        return None
    alpha = im.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return im.size
    w, h = im.size
    bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
    if bw >= w - 2 and bh >= h - 2:
        return im.size                           # full-bleed: nothing to trim or shift
    mark = im.crop(bbox)
    # alpha-weighted centre of mass of the mark, relative to its own box
    a = mark.getchannel("A")
    px = a.load()
    total = sx = sy = 0
    step = max(1, min(bw, bh) // 120)            # sample at most ~120 rows/cols
    for y in range(0, bh, step):
        for x in range(0, bw, step):
            v = px[x, y]
            if v:
                total += v
                sx += v * x
                sy += v * y
    if total:
        cx, cy = sx / total, sy / total
    else:
        cx, cy = bw / 2, bh / 2
    side = int(max(bw, bh) * 1.16) + 2           # 8%% margin each side
    cap = side * 0.05
    dx = max(-cap, min(cap, bw / 2 - cx))        # move the mark so its mass sits centre
    dy = max(-cap, min(cap, bh / 2 - cy))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(mark, (int(round((side - bw) / 2 + dx)), int(round((side - bh) / 2 + dy))), mark)
    canvas.save(path, optimize=True)
    return canvas.size


def png_size(b):
    if b[:8] != b"\x89PNG\r\n\x1a\n" or len(b) < 24:
        return None
    return struct.unpack(">II", b[16:24])


def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "image/png,image/*;q=0.8,*/*;q=0.5"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_logo(sym):
    for src in SOURCES:
        try:
            b = fetch(src(sym))
        except Exception:
            continue
        size = png_size(b)
        if size and min(size) >= MIN_PX:
            return b, size
    return None, None


def load_symbols():
    syms = set()
    for rel in ("docs/iq/screener.json", "docs/iq/etf.json"):
        try:
            for r in json.load(open(os.path.join(HERE, rel)))["rows"]:
                s = str(r.get("sym") or "").upper()
                if s and all(c.isalnum() or c in "-." for c in s):
                    syms.add(s)
        except Exception as e:
            print("skip %s: %s" % (rel, e), file=sys.stderr)
    return sorted(syms)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if "--renormalise" in sys.argv:
        n = 0
        for fn in sorted(os.listdir(OUT_DIR)):
            if fn.endswith(".png"):
                normalise(os.path.join(OUT_DIR, fn))
                n += 1
        print("renormalised %d logos" % n)
    manifest = {}
    if os.path.exists(MANIFEST):
        try:
            manifest = json.load(open(MANIFEST)).get("syms", {})
        except Exception:
            manifest = {}
    syms = load_symbols()
    missing = [s for s in syms if s not in manifest or not os.path.exists(os.path.join(OUT_DIR, s + ".png"))]
    print("symbols %d, already have %d, fetching %d" % (len(syms), len(syms) - len(missing), len(missing)))
    t0 = time.time()
    got = 0

    def work(sym):
        b, size = get_logo(sym)
        if not b:
            return sym, None
        path = os.path.join(OUT_DIR, sym + ".png")
        with open(path, "wb") as f:
            f.write(b)
        size = normalise(path) or size
        return sym, size

    with ThreadPoolExecutor(max_workers=8) as ex:
        for sym, size in ex.map(work, missing):
            if size:
                manifest[sym] = [int(size[0]), int(size[1])]
                got += 1
    # drop manifest entries whose file vanished; fill in the light flag where it is missing
    manifest = {s: v for s, v in manifest.items() if os.path.exists(os.path.join(OUT_DIR, s + ".png"))}
    flagged = 0
    for s, v in manifest.items():
        if "--renormalise" in sys.argv:
            v = list(png_size(open(os.path.join(OUT_DIR, s + ".png"), "rb").read(24)) or v[:2])
        if len(v) < 3 or "--renormalise" in sys.argv:
            light = mark_is_light(os.path.join(OUT_DIR, s + ".png"))
            if light is not None:
                manifest[s] = [v[0], v[1], light]
                flagged += 1
    if flagged:
        print("light flags computed for %d logos" % flagged)
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"updated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(), "count": len(manifest), "syms": manifest}, f, separators=(",", ":"))
    os.replace(tmp, MANIFEST)
    print("logos: fetched %d new in %.0fs, %d total, %d without a logo" % (got, time.time() - t0, len(manifest), len(syms) - len(manifest)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
