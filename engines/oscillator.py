"""IQ Oscillator engine — Python port of iq-oscillator.pine for the scanner.

Ground truth: /Users/kubakaszynski/Desktop/IQ ALGO/Indicator/iq-oscillator.pine
(338 lines). Bar-for-bar Pine v6 semantics; every bar treated as confirmed
(daily scanner runs on closed bars only). Visual toggles are irrelevant —
engines and alerts always run in the Pine, so everything is always computed
here.

Public entry point:

    scan(o, h, l, c, v, *, wave_mode="Balanced", smooth_len=3, sig_len=4,
         turn_conf=1, ext_strict=85, ext_look=200, flow_len=14,
         flow_scale=0.6, div_sens=5, collect_event_counts=False) -> dict

Inputs are parallel lists of floats, OLDEST FIRST, confirmed bars only.
Returns a JSON-shaped dict: current state on the last bar + events fired
ON the last bar. Feed >= 300 bars before the scan window (extremes need
ext_look wave values; the dc regime is path-dependent and converges after
its first flip).

Event notes:
- turn_up / turn_dn are bigTurn-gated (|wave at bend| >= 12) for chart
  parity with the plotted dots; turn_up_ungated / turn_dn_ungated carry
  the raw engine condition (Pine alerts never fire turns at all).
- rev_up / rev_dn (reversal diamonds) are NOT bigTurn-gated, per the Pine.
- The bend bar sits turn_conf bars before the confirmation bar.
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
_gt, _lt, _ge, _le = ta.gt, ta.lt, ta.ge, ta.le

# Wave speed presets: fast / slow / core lengths (internal, IP-masked)
MODE_LENGTHS = {
    "Sharp": (4, 10, 6),
    "Fast": (5, 13, 9),
    "Balanced": (8, 21, 14),
    "Slow": (13, 34, 21),
}

BIG_TURN_MIN_ABS = 12.0   # plot gate: math.abs(wave[turnConf]) >= 12
FLOW_EMA_LEN = 5          # ta.ema(mfi - 50, 5)
DC_SMA_LEN = 33           # confluence clone: ta.sma(ohlc4, 33)
DC_EMA_LEN = 4            # ta.ema(..., 4) on basis and sd
DC_ATR_LEN = 14
DC_CONFIRM = 2            # sticky regime confirm bars

EVENT_NAMES = (
    "flip_up", "flip_dn",
    "turn_up", "turn_dn", "turn_up_ungated", "turn_dn_ungated",
    "rev_up", "rev_dn",
    "dual_long", "dual_short",
    "bull_div", "bear_div", "h_bull_div", "h_bear_div",
    "enter_hi", "enter_lo",
)


def _jf(x, nd=4):
    """nan -> None, else rounded float (JSON-safe)."""
    return None if _na(x) else round(float(x), nd)


def scan(o, h, l, c, v, *, wave_mode="Balanced", smooth_len=3, sig_len=4,
         turn_conf=1, ext_strict=85, ext_look=200, flow_len=14,
         flow_scale=0.6, div_sens=5, collect_event_counts=False):
    """Run the IQ Oscillator engine over a confirmed-bar history and
    report last-bar state + events. See module docstring."""
    n = len(c)
    if n == 0:
        raise ValueError("empty series")
    if not (len(o) == len(h) == len(l) == len(v) == n):
        raise ValueError("o,h,l,c,v must be parallel lists of equal length")
    if wave_mode not in MODE_LENGTHS:
        raise ValueError("wave_mode must be one of %s" % (sorted(MODE_LENGTHS),))

    fast_len, slow_len, core_len = MODE_LENGTHS[wave_mode]

    # ── wave / signal / flow ──────────────────────────────────────────
    ema_fast = ta.ema(c, fast_len)
    ema_slow = ta.ema(c, slow_len)
    ema_diff = [NAN if (_na(ema_fast[i]) or _na(ema_slow[i]))
                else ema_fast[i] - ema_slow[i] for i in range(n)]
    rsi_d = ta.rsi(ema_diff, core_len)
    wave_raw = [NAN if _na(x) else x - 50.0 for x in rsi_d]
    wave = ta.ema(wave_raw, smooth_len)
    sig = ta.ema(wave, sig_len)

    hlc3 = [(h[i] + l[i] + c[i]) / 3.0 for i in range(n)]
    mfi_s = ta.mfi(hlc3, v, flow_len)
    flow = [NAN if _na(x) else x * flow_scale
            for x in ta.ema([NAN if _na(x) else x - 50.0 for x in mfi_s],
                            FLOW_EMA_LEN)]

    # ── adaptive extremes ─────────────────────────────────────────────
    hi_zone = ta.percentile_linear_interpolation(wave, ext_look, ext_strict)
    lo_zone = ta.percentile_linear_interpolation(wave, ext_look, 100 - ext_strict)
    stretched_hi = [(not _na(hi_zone[i])) and _ge(wave[i], hi_zone[i])
                    for i in range(n)]
    stretched_lo = [(not _na(lo_zone[i])) and _le(wave[i], lo_zone[i])
                    for i in range(n)]

    # ── confluence clone series (Bands lineage, hardcoded constants) ──
    ohlc4 = [(o[i] + h[i] + l[i] + c[i]) / 4.0 for i in range(n)]
    dc_basis = ta.ema(ta.sma(ohlc4, DC_SMA_LEN), DC_EMA_LEN)
    dc_sd = ta.ema(ta.stdev(c, DC_SMA_LEN), DC_EMA_LEN)
    atr14 = ta.atr(h, l, c, DC_ATR_LEN)
    dc_half = [NAN] * n
    for i in range(n):
        sd = dc_sd[i]
        if _na(sd):
            continue  # math.max with na -> na
        a = atr14[i]
        fallback = (h[i] - l[i]) if _na(a) else a  # nz(atr, high - low)
        dc_half[i] = max(0.25 * sd, 0.5 * fallback)

    # ── divergence pivots (confirm div_sens bars late) ────────────────
    wph = ta.pivothigh(wave, div_sens, div_sens)
    wpl = ta.pivotlow(wave, div_sens, div_sens)

    # ── per-bar walk: state machines + events ─────────────────────────
    up_stk = 0
    dn_stk = 0
    dc_up = 0
    dc_dn = 0
    dc_bull = None    # tri-state: None until first assignment resolves
    dc_init = False
    last_wph_val = None
    last_wph_prc = None
    last_wpl_val = None
    last_wpl_prc = None

    counts = {k: 0 for k in EVENT_NAMES}
    last_events = None
    last_turn_bend = (None, None)  # (bars_ago, wave value) on last bar

    for i in range(n):
        w = wave[i]
        w1 = wave[i - 1] if i > 0 else NAN

        # zero-cross flips (na comparison -> false)
        flip_up = _gt(w, 0.0) and _le(w1, 0.0)
        flip_dn = _lt(w, 0.0) and _ge(w1, 0.0)

        # turn streaks (updated BEFORE turn check, Pine order; equal wave
        # or na resets both)
        up_stk = up_stk + 1 if _gt(w, w1) else 0
        dn_stk = dn_stk + 1 if _lt(w, w1) else 0

        bend_i = i - turn_conf
        prev_bend_i = i - turn_conf - 1
        turn_up_raw = (up_stk == turn_conf and prev_bend_i >= 0
                       and _le(wave[bend_i], wave[prev_bend_i]))
        turn_dn_raw = (dn_stk == turn_conf and prev_bend_i >= 0
                       and _ge(wave[bend_i], wave[prev_bend_i]))
        big_turn = False
        if (turn_up_raw or turn_dn_raw) and not _na(wave[bend_i]):
            big_turn = abs(wave[bend_i]) >= BIG_TURN_MIN_ABS
        turn_up = turn_up_raw and big_turn   # chart-parity gated dots
        turn_dn = turn_dn_raw and big_turn
        # reversal diamonds: stretched AT the bend bar, NOT bigTurn-gated
        rev_up = turn_up_raw and bend_i >= 0 and stretched_lo[bend_i]
        rev_dn = turn_dn_raw and bend_i >= 0 and stretched_hi[bend_i]

        # dc regime: streaks first, then sticky tri-state (Pine order)
        basis = dc_basis[i]
        half = dc_half[i]
        upper = NAN if (_na(basis) or _na(half)) else basis + half
        lower = NAN if (_na(basis) or _na(half)) else basis - half
        dc_up = dc_up + 1 if _gt(c[i], upper) else 0
        dc_dn = dc_dn + 1 if _lt(c[i], lower) else 0
        prev_dc_bull = dc_bull
        if not dc_init:
            # bar-0 init against a (normally na) basis: writes na -> None
            dc_bull = None if _na(basis) else (c[i] > basis)
            dc_init = True
        elif dc_up >= DC_CONFIRM:
            dc_bull = True
        elif dc_dn >= DC_CONFIRM:
            dc_bull = False

        # dual-flip confluence (None regime behaves as False)
        db = dc_bull is True
        pdb = prev_dc_bull is True
        dual_long = (flip_up and db) or (db and not pdb and _gt(w, 0.0))
        dual_short = ((flip_dn and not db)
                      or (not db and pdb and _lt(w, 0.0)))

        # divergences on confirmed pivots (event fires on confirmation bar)
        bull_div = bear_div = h_bull_div = h_bear_div = False
        ph = wph[i]
        if not _na(ph):
            ph_prc = h[i - div_sens]  # price high at the pivot bar
            if last_wph_val is not None:
                if ph < last_wph_val and ph_prc > last_wph_prc:
                    bear_div = True      # price HH, wave LH
                if ph > last_wph_val and ph_prc < last_wph_prc:
                    h_bear_div = True    # price LH, wave HH
            last_wph_val, last_wph_prc = ph, ph_prc
        pl = wpl[i]
        if not _na(pl):
            pl_prc = l[i - div_sens]  # price low at the pivot bar
            if last_wpl_val is not None:
                if pl > last_wpl_val and pl_prc < last_wpl_prc:
                    bull_div = True      # price LL, wave HL
                if pl < last_wpl_val and pl_prc > last_wpl_prc:
                    h_bull_div = True    # price LH, wave HL (continuation)
            last_wpl_val, last_wpl_prc = pl, pl_prc

        # zone-entry events
        enter_hi = stretched_hi[i] and not (stretched_hi[i - 1] if i > 0 else False)
        enter_lo = stretched_lo[i] and not (stretched_lo[i - 1] if i > 0 else False)

        events = {
            "flip_up": flip_up, "flip_dn": flip_dn,
            "turn_up": turn_up, "turn_dn": turn_dn,
            "turn_up_ungated": turn_up_raw, "turn_dn_ungated": turn_dn_raw,
            "rev_up": rev_up, "rev_dn": rev_dn,
            "dual_long": dual_long, "dual_short": dual_short,
            "bull_div": bull_div, "bear_div": bear_div,
            "h_bull_div": h_bull_div, "h_bear_div": h_bear_div,
            "enter_hi": enter_hi, "enter_lo": enter_lo,
        }
        if collect_event_counts:
            for k, fired in events.items():
                if fired:
                    counts[k] += 1
        if i == n - 1:
            last_events = events
            if turn_up_raw or turn_dn_raw:
                last_turn_bend = (turn_conf, _jf(wave[bend_i]))

    # ── last-bar state snapshot ───────────────────────────────────────
    w = wave[n - 1]
    w1 = wave[n - 2] if n > 1 else NAN
    s = sig[n - 1]
    f = flow[n - 1]

    state = {
        "wave": _jf(w),
        "wave_prev": _jf(w1),
        "wave_slope": (None if (_na(w) or _na(w1))
                       else ("rising" if w > w1 else "falling")),
        "signal": _jf(s),
        "side": None if _na(w) else ("bull" if w >= 0 else "bear"),
        "wave_vs_signal": (None if (_na(w) or _na(s))
                           else ("above" if w > s else "below")),
        "flow": _jf(f),
        "flow_side": None if _na(f) else ("BUYING" if f >= 0 else "SELLING"),
        "stretched_hi": stretched_hi[n - 1],
        "stretched_lo": stretched_lo[n - 1],
        "hi_zone": _jf(hi_zone[n - 1]),
        "lo_zone": _jf(lo_zone[n - 1]),
        "dc_bull": dc_bull,  # True / False / None (regime not yet resolved)
        "confluence": (int(_gt(w, 0.0)) + int(_gt(w, s))
                       + int(_gt(f, 0.0)) + int(dc_bull is True)),
    }

    result = {
        "engine": "iq-oscillator",
        "mode": wave_mode,
        "bars": n,
        "state": state,
        "events": last_events,
        "events_fired": [k for k in EVENT_NAMES if last_events[k]],
        "turn_bend_bars_ago": last_turn_bend[0],
        "turn_bend_value": last_turn_bend[1],
    }
    if collect_event_counts:
        result["event_counts"] = counts
    return result


# ── self-test ─────────────────────────────────────────────────────────

def _synthetic_ohlcv(seed=42):
    """Deterministic trend + chop + downtrend + recovery, ~640 bars."""
    import random
    rng = random.Random(seed)
    closes = []
    px = 100.0
    segments = [
        (220, 0.60, 0.40, 0.0),    # steady uptrend
        (160, 0.00, 0.50, 4.0),    # sideways chop with a sine swing
        (160, -0.70, 0.45, 0.0),   # downtrend
        (100, 0.55, 0.40, 0.0),    # recovery
    ]
    t = 0
    for bars, drift, noise, chop_amp in segments:
        for _ in range(bars):
            px += drift + rng.gauss(0.0, noise)
            px = max(px, 5.0)
            wobble = chop_amp * math.sin(2.0 * math.pi * t / 20.0)
            closes.append(px + wobble)
            t += 1
    o, h, l, c, v = [], [], [], [], []
    prev = closes[0]
    for cl in closes:
        op = prev
        spread = abs(rng.gauss(0.0, 0.3)) + 0.05
        h.append(max(op, cl) + spread)
        l.append(min(op, cl) - spread)
        o.append(op)
        c.append(cl)
        v.append(1_000_000.0 * (1.0 + rng.uniform(-0.4, 0.6)))
        prev = cl
    return o, h, l, c, v


if __name__ == "__main__":
    import json

    o, h, l, c, v = _synthetic_ohlcv()
    n = len(c)

    # 1) full run: sane state, JSON-safe, all guaranteed event families fire
    res = scan(o, h, l, c, v, collect_event_counts=True)
    json.dumps(res)  # must be serializable
    st = res["state"]
    assert isinstance(st["wave"], float) and abs(st["wave"]) <= 50.0, st["wave"]
    assert isinstance(st["signal"], float)
    assert st["side"] in ("bull", "bear")
    assert st["wave_slope"] in ("rising", "falling")
    assert st["wave_vs_signal"] in ("above", "below")
    assert st["flow_side"] in ("BUYING", "SELLING")
    assert st["hi_zone"] is not None and st["lo_zone"] is not None
    assert st["hi_zone"] > st["lo_zone"]
    assert st["dc_bull"] in (True, False), "regime should resolve on 640 bars"
    assert 0 <= st["confluence"] <= 4
    ec = res["event_counts"]
    for k in ("flip_up", "flip_dn", "turn_up", "turn_dn",
              "turn_up_ungated", "turn_dn_ungated",
              "enter_hi", "enter_lo", "dual_long", "dual_short"):
        assert ec[k] > 0, "expected %s to fire at least once: %s" % (k, ec)
    assert ec["turn_up_ungated"] >= ec["turn_up"]  # gate only removes
    assert ec["turn_dn_ungated"] >= ec["turn_dn"]

    # 2) regime reads: mid-downtrend must be bear, fresh recovery leg bull
    #    (wave tracks emaDiff DELTAS, so a long steady trend converges the
    #    wave toward zero — probe mid-leg, not at a segment boundary)
    res_dn = scan(o[:420], h[:420], l[:420], c[:420], v[:420])
    assert res_dn["state"]["side"] == "bear", res_dn["state"]
    assert res_dn["state"]["dc_bull"] is False, res_dn["state"]
    assert res_dn["state"]["flow_side"] == "SELLING", res_dn["state"]
    assert res_dn["state"]["confluence"] <= 1, res_dn["state"]
    res_up = scan(o[:560], h[:560], l[:560], c[:560], v[:560])
    assert res_up["state"]["side"] == "bull", res_up["state"]
    assert res_up["state"]["dc_bull"] is True, res_up["state"]
    assert res_up["state"]["flow_side"] == "BUYING", res_up["state"]
    assert res_up["state"]["confluence"] >= 3, res_up["state"]

    # 3) warmup: 10 bars -> wave undefined, no events, no exception
    res_w = scan(o[:10], h[:10], l[:10], c[:10], v[:10])
    assert res_w["state"]["wave"] is None
    assert res_w["state"]["side"] is None
    assert res_w["state"]["dc_bull"] is None
    assert res_w["events_fired"] == [], res_w["events_fired"]
    json.dumps(res_w)

    # 4) events dict always carries the full catalog, booleans only
    assert set(res["events"].keys()) == set(EVENT_NAMES)
    assert all(isinstance(x, bool) for x in res["events"].values())

    print("SELF-TEST PASS  bars=%d  last-bar state=%s" % (n, json.dumps(st)))
    print("event counts over full history: %s" % json.dumps(ec))
    print("events fired on last bar: %s" % res["events_fired"])
