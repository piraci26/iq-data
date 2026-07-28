"""IQ Structure engine — Python port of iq-structure.pine for the scanner.

Ground truth: /Users/kubakaszynski/Desktop/IQ ALGO/Indicator/iq-structure.pine
(767 lines). Bar-for-bar Pine v6 semantics; every bar is treated as
confirmed (daily scanner runs on closed bars only). Visual toggles gate
rendering only, so every engine below always runs.

Public entry point:

    scan(o, h, l, c, v, *, struct_len=5, maj_len=40,
         liq_tol_x=0.25, liq_max=3) -> dict

Inputs are parallel lists of floats, OLDEST FIRST, confirmed bars only.
Returns a JSON-shaped dict (no NaN anywhere — nan maps to None): current
state on the last bar + events fired ON the last bar. The whole module is
path-dependent from bar 0 (structDir starts 0, CHoCH+ flags start False,
pending levels persist); feed >= 500 daily bars of warmup before the scan
window for effective TV parity.

Ported engines (Pine execution order preserved within each bar):
  1. internal pivots (structLen/structLen) -> swing tags HH/HL/LH/LL,
     EQH/EQL liquidity levels, trendline (re)creation + pending levels
  2. major pivots (majEff = max(majLen, structLen+2)) -> tags + major
     pending levels (the "major level rays")
  3. internal breaks: BOS / CHoCH / CHoCH+ grading + flag lifecycle
  4. major breaks: same grading on the major tier
  5. trendline break checks (latest line per side only)
  6. lifecycle scans: liquidity sweep / clean-break, then FIFO trims —
     so a level created earlier THIS bar can be swept the same bar

OMITTED IN v1 (deliberate — the scanner needs no boxes):
  - ORDER BLOCKS: creation on internal breaks, kill/touch lifecycle,
    volumetric share. Events ob_touch_bull / ob_touch_bear absent.
  - FAIR VALUE GAPS: creation/shrink/fill. FVG events absent. (In the
    Pine this engine is the only one gated by its visual toggle showFvg;
    a future port should run it with showFvg=true.)
  Because OB/FVG state feeds nothing else in the Pine (breaks, tags,
  liquidity and trendlines never read it), omitting them cannot drift
  the ported state.

Faithfully kept Pine quirks (do not "fix"):
- Swing-tag ties grade against the trend: ph == prevHiVal -> "LH",
  pl == prevLoVal -> "HL" (strict > / < for HH / LL).
- Pivot ties invalidate (strict on both sides) — see ta.pivothigh.
- structDir starts 0, so the FIRST break of each tier always grades BOS.
- CHoCH+ flag lifecycle: consuming a HIGH level (up-break) clears
  lastHiWasLH; consuming a LOW level clears lastLoWasHL (no stale '+').
- A trendline already pierced at creation freezes broken with NO event.
- EQH/EQL dedupe + creation tolerance use liqTol = 0.25*ATR(14) evaluated
  at the bar where the check runs; stored levels are frozen prices.
- EQ FIFO trim to liqMax runs at END of bar (after the sweep scan), so a
  4th level can exist during — and be swept by — its creation bar.
- Sweep: wick through + close back = sweep event; clean close through =
  silent removal (no event).
"""

import math

try:
    from . import ta
except ImportError:  # run as a plain script / flat import
    import os
    import sys
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import ta

NAN = float("nan")
_na = ta.is_na

_EVENT_KEYS = (
    "bos_up", "choch_up", "choch_up_plus",
    "bos_dn", "choch_dn", "choch_dn_plus",
    "maj_bos_up", "maj_choch_up", "maj_choch_up_plus",
    "maj_bos_dn", "maj_choch_dn", "maj_choch_dn_plus",
    "tl_break_up", "tl_break_dn",
    "sweep_hi", "sweep_lo",
)


def _jf(x, nd=6):
    """JSON-safe float: nan/None -> None, else rounded float."""
    if _na(x):
        return None
    return round(float(x), nd)


def _line_new(x1, y1, x2, y2):
    """Pine line.new through two anchors, extended right (linear)."""
    return {
        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
        "slope": (y2 - y1) / (x2 - x1),
        "broken": False,
    }


def _line_price(ln, x):
    """Pine line.get_price: linear extrapolation from the two anchors."""
    return ln["y1"] + ln["slope"] * (x - ln["x1"])


def _tag_rec(side, tag, bar, price):
    return {"side": side, "tag": tag, "bar": bar, "price": price}


def _simulate(o, h, l, c, v, struct_len, maj_len, liq_tol_x, liq_max):
    """Run the full path-dependent state machine. Returns (state, log)
    where log[i] is the event/debug record for bar i."""
    n = len(c)
    if not (len(o) == len(h) == len(l) == n and (v is None or len(v) == n)):
        raise ValueError("o,h,l,c,v must be parallel lists of equal length")

    maj_eff = max(maj_len, struct_len + 2)

    atr14 = ta.atr(h, l, c, 14)
    ph_i = ta.pivothigh(h, struct_len, struct_len)
    pl_i = ta.pivotlow(l, struct_len, struct_len)
    ph_m = ta.pivothigh(h, maj_eff, maj_eff)
    pl_m = ta.pivotlow(l, maj_eff, maj_eff)

    # ── internal tier state ──────────────────────────────────────────
    last_hi = None          # pending up-break level (None = consumed)
    last_hi_bar = 0
    last_lo = None
    last_lo_bar = 0
    prev_hi_val = None      # last confirmed pivot high (tag/EQH/trendline)
    prev_hi_bar = 0
    prev_lo_val = None
    prev_lo_bar = 0
    struct_dir = 0
    last_hi_was_lh = False
    last_lo_was_hl = False

    # ── major tier state ─────────────────────────────────────────────
    last_hi_m = None
    last_hi_bar_m = 0
    last_lo_m = None
    last_lo_bar_m = 0
    prev_hi_val_m = None
    prev_lo_val_m = None
    struct_dir_m = 0
    last_hi_was_lh_m = False
    last_lo_was_hl_m = False

    # ── liquidity / trendlines ───────────────────────────────────────
    eqh = []                # active EQH levels, oldest first
    eql = []
    tl_dn = None            # latest resistance line (falling highs)
    tl_up = None            # latest support line (rising lows)

    # swing tag records
    last_tag = {"internal_high": None, "internal_low": None,
                "major_high": None, "major_low": None}
    recent_int = []         # rolling internal tags, chronological
    recent_maj = []

    log = []

    for i in range(n):
        ev = dict.fromkeys(_EVENT_KEYS, False)
        detail = {}
        atr_i = atr14[i]
        liq_tol = None if _na(atr_i) else liq_tol_x * atr_i

        # ── 1a. internal pivot high confirmation ─────────────────────
        ph = ph_i[i]
        if not _na(ph):
            p_bar = i - struct_len
            tag_h = "H" if prev_hi_val is None else ("HH" if ph > prev_hi_val else "LH")
            last_hi_was_lh = tag_h == "LH"
            rec = _tag_rec("high", tag_h, p_bar, ph)
            last_tag["internal_high"] = rec
            recent_int.append(rec)
            # EQH creation (live liqTol; nan tol -> no creation)
            if (prev_hi_val is not None and liq_tol is not None
                    and abs(ph - prev_hi_val) <= liq_tol):
                lvl = (ph + prev_hi_val) / 2.0
                if all(abs(x - lvl) > liq_tol for x in eqh):
                    eqh.append(lvl)
            # resistance trendline: two falling highs, REPLACES the old one
            if prev_hi_val is not None and ph < prev_hi_val:
                tl_dn = _line_new(prev_hi_bar, prev_hi_val, p_bar, ph)
                if c[i] > _line_price(tl_dn, i):
                    tl_dn["broken"] = True  # pierced at creation: NO event
            prev_hi_val, prev_hi_bar = ph, p_bar
            last_hi, last_hi_bar = ph, p_bar

        # ── 1b. internal pivot low confirmation (mirror) ─────────────
        pl = pl_i[i]
        if not _na(pl):
            q_bar = i - struct_len
            tag_l = "L" if prev_lo_val is None else ("LL" if pl < prev_lo_val else "HL")
            last_lo_was_hl = tag_l == "HL"
            rec = _tag_rec("low", tag_l, q_bar, pl)
            last_tag["internal_low"] = rec
            recent_int.append(rec)
            if (prev_lo_val is not None and liq_tol is not None
                    and abs(pl - prev_lo_val) <= liq_tol):
                lvl = (pl + prev_lo_val) / 2.0
                if all(abs(x - lvl) > liq_tol for x in eql):
                    eql.append(lvl)
            # support trendline: two rising lows
            if prev_lo_val is not None and pl > prev_lo_val:
                tl_up = _line_new(prev_lo_bar, prev_lo_val, q_bar, pl)
                if c[i] < _line_price(tl_up, i):
                    tl_up["broken"] = True  # pierced at creation: NO event
            prev_lo_val, prev_lo_bar = pl, q_bar
            last_lo, last_lo_bar = pl, q_bar

        # ── 2a. major pivot high (tags + level ray only) ─────────────
        phm = ph_m[i]
        if not _na(phm):
            p_bar_m = i - maj_eff
            tag_hm = "H" if prev_hi_val_m is None else ("HH" if phm > prev_hi_val_m else "LH")
            last_hi_was_lh_m = tag_hm == "LH"
            rec = _tag_rec("high", tag_hm, p_bar_m, phm)
            last_tag["major_high"] = rec
            recent_maj.append(rec)
            prev_hi_val_m = phm
            last_hi_m, last_hi_bar_m = phm, p_bar_m

        # ── 2b. major pivot low ──────────────────────────────────────
        plm = pl_m[i]
        if not _na(plm):
            q_bar_m = i - maj_eff
            tag_lm = "L" if prev_lo_val_m is None else ("LL" if plm < prev_lo_val_m else "HL")
            last_lo_was_hl_m = tag_lm == "HL"
            rec = _tag_rec("low", tag_lm, q_bar_m, plm)
            last_tag["major_low"] = rec
            recent_maj.append(rec)
            prev_lo_val_m = plm
            last_lo_m, last_lo_bar_m = plm, q_bar_m

        # ── 3a. internal up-break (a pivot set THIS bar can break now)
        if last_hi is not None and c[i] > last_hi:
            is_ch = struct_dir < 0
            plus = is_ch and last_lo_was_hl
            ev["choch_up" if is_ch else "bos_up"] = True
            ev["choch_up_plus"] = plus
            detail["up_break_level"] = last_hi
            # (Pine creates a demand order block here — omitted in v1)
            struct_dir = 1
            last_hi = None
            last_hi_was_lh = False  # consumed level clears the '+' flag

        # ── 3b. internal down-break ──────────────────────────────────
        if last_lo is not None and c[i] < last_lo:
            is_ch = struct_dir > 0
            plus = is_ch and last_hi_was_lh
            ev["choch_dn" if is_ch else "bos_dn"] = True
            ev["choch_dn_plus"] = plus
            detail["dn_break_level"] = last_lo
            # (Pine creates a supply order block here — omitted in v1)
            struct_dir = -1
            last_lo = None
            last_lo_was_hl = False

        # ── 4a. major up-break ───────────────────────────────────────
        if last_hi_m is not None and c[i] > last_hi_m:
            is_ch = struct_dir_m < 0
            plus = is_ch and last_lo_was_hl_m
            ev["maj_choch_up" if is_ch else "maj_bos_up"] = True
            ev["maj_choch_up_plus"] = plus
            detail["maj_up_break_level"] = last_hi_m
            struct_dir_m = 1
            last_hi_m = None
            last_hi_was_lh_m = False

        # ── 4b. major down-break ─────────────────────────────────────
        if last_lo_m is not None and c[i] < last_lo_m:
            is_ch = struct_dir_m > 0
            plus = is_ch and last_hi_was_lh_m
            ev["maj_choch_dn" if is_ch else "maj_bos_dn"] = True
            ev["maj_choch_dn_plus"] = plus
            detail["maj_dn_break_level"] = last_lo_m
            struct_dir_m = -1
            last_lo_m = None
            last_lo_was_hl_m = False

        # ── 5. FVG creation would run here (omitted in v1) ───────────

        # ── 6. trendline break checks (latest line per side only) ────
        if tl_dn is not None and not tl_dn["broken"] and i >= 1:
            lvl_now = _line_price(tl_dn, i)
            lvl_prev = _line_price(tl_dn, i - 1)
            if c[i] > lvl_now and c[i - 1] <= lvl_prev:
                tl_dn["broken"] = True
                ev["tl_break_up"] = True
        if tl_up is not None and not tl_up["broken"] and i >= 1:
            lvl_now = _line_price(tl_up, i)
            lvl_prev = _line_price(tl_up, i - 1)
            if c[i] < lvl_now and c[i - 1] >= lvl_prev:
                tl_up["broken"] = True
                ev["tl_break_dn"] = True

        # ── 7. liquidity sweep / clean-break scan (newest -> oldest);
        #      a level created earlier THIS bar is scanned too ─────────
        for k in range(len(eqh) - 1, -1, -1):
            lvl = eqh[k]
            if h[i] > lvl and c[i] < lvl:
                del eqh[k]
                ev["sweep_hi"] = True
                detail["swept_hi_level"] = lvl
            elif c[i] > lvl:
                del eqh[k]          # clean break: silent removal
        for k in range(len(eql) - 1, -1, -1):
            lvl = eql[k]
            if l[i] < lvl and c[i] > lvl:
                del eql[k]
                ev["sweep_lo"] = True
                detail["swept_lo_level"] = lvl
            elif c[i] < lvl:
                del eql[k]

        # ── 8. end-of-bar FIFO trims (AFTER the sweep scan, as in Pine)
        while len(eqh) > liq_max:
            eqh.pop(0)
        while len(eql) > liq_max:
            eql.pop(0)
        if len(recent_int) > 8:
            del recent_int[:len(recent_int) - 8]
        if len(recent_maj) > 4:
            del recent_maj[:len(recent_maj) - 4]

        entry = {"bar": i, "dir": struct_dir, "dir_m": struct_dir_m,
                 "eqh_count": len(eqh), "eql_count": len(eql)}
        entry.update(ev)
        entry.update(detail)
        log.append(entry)

    state = {
        "n": n, "maj_eff": maj_eff, "atr14": atr14[-1] if n else NAN,
        "struct_dir": struct_dir, "struct_dir_m": struct_dir_m,
        "last_hi": last_hi, "last_hi_bar": last_hi_bar,
        "last_lo": last_lo, "last_lo_bar": last_lo_bar,
        "last_hi_m": last_hi_m, "last_hi_bar_m": last_hi_bar_m,
        "last_lo_m": last_lo_m, "last_lo_bar_m": last_lo_bar_m,
        "last_hi_was_lh": last_hi_was_lh, "last_lo_was_hl": last_lo_was_hl,
        "last_hi_was_lh_m": last_hi_was_lh_m,
        "last_lo_was_hl_m": last_lo_was_hl_m,
        "eqh": list(eqh), "eql": list(eql),
        "tl_dn": tl_dn, "tl_up": tl_up,
        "last_tag": last_tag,
        "recent_int": list(recent_int), "recent_maj": list(recent_maj),
    }
    return state, log


def _shape_tag(rec, last_bar):
    if rec is None:
        return None
    return {"tag": rec["tag"], "side": rec["side"], "bar": rec["bar"],
            "bars_ago": last_bar - rec["bar"], "price": _jf(rec["price"])}


def _shape_line(ln, last_bar):
    if ln is None:
        return None
    return {"x1": ln["x1"], "y1": _jf(ln["y1"]),
            "x2": ln["x2"], "y2": _jf(ln["y2"]),
            "slope": _jf(ln["slope"], 8),
            "level_now": _jf(_line_price(ln, last_bar)),
            "broken": ln["broken"]}


def scan(o, h, l, c, v, *, struct_len=5, maj_len=40,
         liq_tol_x=0.25, liq_max=3):
    """Run the IQ Structure engine over the full history and report the
    state as of — and the events fired ON — the last confirmed bar.
    Returns a JSON-safe dict (no NaN)."""
    state, log = _simulate(o, h, l, c, v, struct_len, maj_len,
                           liq_tol_x, liq_max)
    last_bar = state["n"] - 1
    ev_row = log[-1] if log else {}
    events = {k: bool(ev_row.get(k, False)) for k in _EVENT_KEYS}

    return {
        "engine": "iq-structure",
        "version": "1.0",
        "bars": state["n"],
        "last_bar_index": last_bar,
        "params": {"struct_len": struct_len, "maj_len": maj_len,
                   "maj_eff": state["maj_eff"],
                   "liq_tol_x": liq_tol_x, "liq_max": liq_max},
        "omitted": ("order blocks and FVGs are not ported in v1 (scanner "
                    "needs no boxes); ob_touch_* and FVG create/fill "
                    "events are absent"),
        "state": {
            "struct_dir": state["struct_dir"],
            "struct_dir_major": state["struct_dir_m"],
            "atr14": _jf(state["atr14"]),
            "pending_levels": {
                "internal_high": _jf(state["last_hi"]),
                "internal_high_bar": state["last_hi_bar"] if state["last_hi"] is not None else None,
                "internal_low": _jf(state["last_lo"]),
                "internal_low_bar": state["last_lo_bar"] if state["last_lo"] is not None else None,
                "major_high": _jf(state["last_hi_m"]),
                "major_high_bar": state["last_hi_bar_m"] if state["last_hi_m"] is not None else None,
                "major_low": _jf(state["last_lo_m"]),
                "major_low_bar": state["last_lo_bar_m"] if state["last_lo_m"] is not None else None,
            },
            # active major level rays == pending major levels (na after break)
            "major_levels": {"high": _jf(state["last_hi_m"]),
                             "low": _jf(state["last_lo_m"])},
            "choch_plus_flags": {
                "internal_last_hi_was_lh": state["last_hi_was_lh"],
                "internal_last_lo_was_hl": state["last_lo_was_hl"],
                "major_last_hi_was_lh": state["last_hi_was_lh_m"],
                "major_last_lo_was_hl": state["last_lo_was_hl_m"],
            },
            "swings": {
                "last_internal_high": _shape_tag(state["last_tag"]["internal_high"], last_bar),
                "last_internal_low": _shape_tag(state["last_tag"]["internal_low"], last_bar),
                "last_major_high": _shape_tag(state["last_tag"]["major_high"], last_bar),
                "last_major_low": _shape_tag(state["last_tag"]["major_low"], last_bar),
                "recent_internal": [_shape_tag(r, last_bar) for r in state["recent_int"]],
                "recent_major": [_shape_tag(r, last_bar) for r in state["recent_maj"]],
            },
            "liquidity": {
                "eqh_levels": [_jf(x) for x in state["eqh"]],
                "eql_levels": [_jf(x) for x in state["eql"]],
                "eqh_count": len(state["eqh"]),
                "eql_count": len(state["eql"]),
            },
            "trendlines": {
                "resistance": _shape_line(state["tl_dn"], last_bar),
                "support": _shape_line(state["tl_up"], last_bar),
            },
        },
        "events": events,
        "events_fired": [k for k in _EVENT_KEYS if events[k]],
    }


# ═════════════════════════════ self-test ══════════════════════════════

def _legs(start, segs):
    """Piecewise-linear close path: segs = [(delta, nbars), ...]."""
    out = [start]
    cur = start
    for delta, nb in segs:
        step = delta / nb
        for k in range(1, nb + 1):
            out.append(cur + step * k)
        cur += delta
    return out


def _synthetic_ohlcv():
    """Deterministic trend + chop + reversal series, ~690 bars.

    A1 zigzag up -> A2 correction (makes a major pivot pair) -> A3 zigzag
    up (breaks the major high) -> B contracting chop (EQH/EQL + sweeps)
    -> C zigzag down (CHoCH+ dn, major CHoCH dn) -> D straight rally
    (CHoCH up, trendline break up).
    """
    segs = []
    for _ in range(8):                       # A1: 8 cycles up
        segs += [(+4.5, 9), (-1.7, 5)]
    segs += [(-10.0, 42)]                    # A2: 42-bar correction
    for _ in range(12):                      # A3: 12 cycles up
        segs += [(+4.5, 9), (-1.7, 5)]
    b_pts = [143.00, 145.90, 143.06, 145.84, 142.98, 145.92,
             143.02, 145.86, 142.96, 145.90, 143.05, 145.80]
    prev = 146.0                             # A3 ends at 146.0
    for pt in b_pts:                         # B: 12 chop legs, 6 bars each
        segs += [(pt - prev, 6)]
        prev = pt
    for _ in range(14):                      # C: 14 cycles down
        segs += [(-4.5, 9), (+1.7, 5)]
    segs += [(+30.0, 100)]                   # D: straight rally

    closes = _legs(100.0, segs)
    n = len(closes)
    o = [closes[0]] * n
    for i in range(1, n):
        o[i] = closes[i - 1] + 0.25 * (closes[i] - closes[i - 1])
    h = [max(o[i], closes[i]) + 0.30 for i in range(n)]
    l = [min(o[i], closes[i]) - 0.30 for i in range(n)]
    v = [1_000_000.0 + (i % 10) * 37_000.0 for i in range(n)]
    return o, h, l, closes, v


def _no_nan(x, path="$"):
    if isinstance(x, float):
        assert x == x, "NaN leaked at %s" % path
    elif isinstance(x, dict):
        for k, y in x.items():
            _no_nan(y, path + "." + str(k))
    elif isinstance(x, (list, tuple)):
        for j, y in enumerate(x):
            _no_nan(y, "%s[%d]" % (path, j))


def _self_test():
    import json

    o, h, l, c, v = _synthetic_ohlcv()
    n = len(c)
    assert n >= 500, "warmup guidance says feed >= 500 bars, got %d" % n

    state, log = _simulate(o, h, l, c, v, 5, 40, 0.25, 3)
    result = scan(o, h, l, c, v)

    counts = {k: sum(1 for row in log if row[k]) for k in _EVENT_KEYS}

    # regimes flip both ways on both tiers
    assert counts["bos_up"] >= 5, counts
    assert counts["bos_dn"] >= 5, counts
    assert counts["choch_up"] >= 2, counts          # A3 recovery + D
    assert counts["choch_dn"] >= 2, counts          # A2 correction + C
    assert counts["choch_dn_plus"] >= 1, counts     # C entry after LH/HL chop
    assert counts["maj_bos_up"] >= 1, counts        # A3 breaks A1 top
    assert counts["maj_choch_dn"] >= 1, counts      # C breaks the major low
    assert counts["maj_bos_dn"] == 0, counts        # D never undercuts C low
    assert counts["maj_choch_up"] == 0, counts      # D never regains 148
    assert counts["sweep_hi"] >= 1, counts          # B stop-runs the EQH
    assert counts["sweep_lo"] >= 1, counts          # B stop-runs the EQL
    assert counts["tl_break_up"] >= 1, counts       # D through C's falling line
    assert counts["tl_break_dn"] >= 1, counts       # A2/C through rising lines

    # events only on defined conditions
    int_keys = ("bos_up", "choch_up", "bos_dn", "choch_dn",
                "tl_break_up", "tl_break_dn", "sweep_hi", "sweep_lo")
    maj_keys = ("maj_bos_up", "maj_choch_up", "maj_bos_dn", "maj_choch_dn")
    for row in log:
        i = row["bar"]
        if i < 2 * 5 + 1:       # first internal pivot confirms at bar 10
            assert not any(row[k] for k in int_keys), row
        if i < 2 * 40 + 1:      # first major pivot confirms at bar 80
            assert not any(row[k] for k in maj_keys), row
        if "up_break_level" in row:
            assert c[i] > row["up_break_level"], row
            assert row["dir"] == 1, row
        if "dn_break_level" in row:
            assert c[i] < row["dn_break_level"], row
            assert row["dir"] == -1, row
        if "maj_up_break_level" in row:
            assert c[i] > row["maj_up_break_level"], row
        if "maj_dn_break_level" in row:
            assert c[i] < row["maj_dn_break_level"], row
        assert row["dir"] in (-1, 0, 1) and row["dir_m"] in (-1, 0, 1)
        assert 0 <= row["eqh_count"] <= 3 and 0 <= row["eql_count"] <= 3
        assert not (row["choch_up_plus"] and not row["choch_up"]), row
        assert not (row["choch_dn_plus"] and not row["choch_dn"]), row

    # final state: tiers diverge by design (D rally vs unbroken major high)
    st = result["state"]
    assert st["struct_dir"] == 1, st["struct_dir"]
    assert st["struct_dir_major"] == -1, st["struct_dir_major"]
    mh = st["major_levels"]["high"]
    ml = st["major_levels"]["low"]
    assert mh is not None and 147.0 < mh < 149.0, mh    # A3 top ray active
    assert ml is not None and 104.0 < ml < 105.5, ml    # C trough ray active
    assert st["swings"]["last_internal_low"]["tag"] in ("LL", "HL", "L")
    assert st["trendlines"]["resistance"] is not None

    # JSON-safe, deterministic
    _no_nan(result)
    blob = json.dumps(result, sort_keys=True)
    assert blob == json.dumps(scan(o, h, l, c, v), sort_keys=True)

    # degenerate inputs: tiny + flat series -> no events, no crash, no NaN
    for m in (1, 5, 20):
        flat = scan([100.0] * m, [100.5] * m, [99.5] * m,
                    [100.0] * m, [1e6] * m)
        assert flat["events_fired"] == [], flat["events_fired"]
        assert flat["state"]["struct_dir"] == 0
        _no_nan(flat)

    fired = {k: counts[k] for k in _EVENT_KEYS if counts[k]}
    print("SELF-TEST PASS  bars=%d  event counts=%s" % (n, fired))
    print("final: dir=%+d dirM=%+d  major ray hi=%.2f lo=%.2f  "
          "eqh=%d eql=%d  last events=%s" % (
              st["struct_dir"], st["struct_dir_major"], mh, ml,
              st["liquidity"]["eqh_count"], st["liquidity"]["eql_count"],
              result["events_fired"]))
    print("last-bar json bytes:", len(blob))


if __name__ == "__main__":
    _self_test()
