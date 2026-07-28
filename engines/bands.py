"""IQ Bands engine — Python port of iq-bands-v2.pine for the scanner.

Ground truth: /Users/kubakaszynski/Desktop/IQ ALGO/Indicator/iq-bands-v2.pine
(624 lines). Bar-for-bar Pine v6 semantics; every bar is treated as
confirmed (daily scanner runs on closed bars only). Visual toggles gate
rendering only — the engine and alerts always run in the Pine, so
everything is always computed here.

Public entry point:

    scan(o, h, l, c, v, *, fvb_len=33, thresh_mult=0.25, smooth_len=4,
         confirm_n=2, thresh_floor=0.5, vol_len=21, vol_sigma=1.0,
         trail_mult=2.0, bb_len=20, bb_mult=2.0, rev_pct=1.5,
         n_len=30, n_thresh=4, debug=False) -> dict

Inputs are parallel lists of floats, OLDEST FIRST, confirmed bars only.
Returns a JSON-shaped dict (no NaN anywhere — nan maps to None): current
state on the last bar + events fired ON the last bar. The regime is
path-dependent from bar 0; feed >= 1 year of daily warmup before the scan
window (it converges after the first flip).

Faithfully kept Pine quirks (do not "fix"):
- Bar-0 `isBull := close > basis` writes na (basis is na) -> regime is
  None until the first 2-bar streak completes; the first assignment to
  True fires a green flip (sigBuy), the first to False fires nothing.
- halfWidth = max(0.25*sd, 0.5*ATR14) with NO nz: nan through ATR warmup.
- Short targets are pre-marked hit when t <= 0 (zero floor); long targets
  get no such guard.
- The trail seeds on bar 0 on the short side (isBull na -> false branch).
- Rearm compares close[1] against the CURRENT bar's threshold (line 169).
- Execution order within a bar: regime -> volume grade -> rearm ->
  run extremes -> target ladder -> trail -> exhaustion -> gauges.
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

FIB1, FIB2, FIB3 = 0.618, 1.0, 1.618

_EVENT_KEYS = (
    "sig_buy", "sig_sell", "strong",
    "rearm_up", "rearm_dn",
    "hit1", "hit2", "hit3",
    "exit_long", "exit_short",
    "exhaust_up", "exhaust_dn",
    "st_fast_flip_up", "st_fast_flip_dn",
    "st_slow_flip_up", "st_slow_flip_dn",
    "macro_flip", "zone_enter_up", "zone_enter_dn",
)


def _jf(x, nd=6):
    """nan/None -> None, else rounded float (JSON-safe)."""
    if _na(x):
        return None
    return round(float(x), nd)


def scan(o, h, l, c, v, *,
         fvb_len=33, thresh_mult=0.25, smooth_len=4, confirm_n=2,
         thresh_floor=0.5, vol_len=21, vol_sigma=1.0, trail_mult=2.0,
         bb_len=20, bb_mult=2.0, rev_pct=1.5, n_len=30, n_thresh=4,
         debug=False):
    n = len(c)
    if not (len(o) == len(h) == len(l) == len(v) == n) or n == 0:
        raise ValueError("o,h,l,c,v must be non-empty parallel lists")

    # ── precomputed series (no path dependence) ──────────────────────
    ohlc4 = [(o[i] + h[i] + l[i] + c[i]) / 4.0 for i in range(n)]
    basis_raw = ta.sma(ohlc4, fvb_len)
    sd_raw = ta.stdev(c, fvb_len)
    basis = ta.ema(basis_raw, smooth_len)
    sd = ta.ema(sd_raw, smooth_len)
    atr14 = ta.atr(h, l, c, 14)

    # halfWidth: NO nz on ATR — nan while either input is nan (bars 0-12+)
    half = [NAN if (_na(sd[i]) or _na(atr14[i]))
            else max(thresh_mult * sd[i], thresh_floor * atr14[i])
            for i in range(n)]
    th_up = [NAN if (_na(basis[i]) or _na(half[i])) else basis[i] + half[i]
             for i in range(n)]
    th_dn = [NAN if (_na(basis[i]) or _na(half[i])) else basis[i] - half[i]
             for i in range(n)]

    # volume grade
    vol_mean = ta.sma(v, vol_len)
    vol_sd = ta.stdev(v, vol_len)
    vol_z = [(v[i] - vol_mean[i]) / vol_sd[i] if ta.gt(vol_sd[i], 0.0) else 0.0
             for i in range(n)]
    high_vol_s = ta.highest(vol_z, confirm_n + 1)  # na first confirm_n bars
    high_vol = [ta.ge(high_vol_s[i], vol_sigma) for i in range(n)]

    # hidden Bollinger (exhaustion)
    bb_mid = ta.sma(c, bb_len)
    bb_sd = ta.stdev(c, bb_len)
    bb_up = [NAN if _na(bb_mid[i]) else bb_mid[i] + bb_mult * bb_sd[i]
             for i in range(n)]
    bb_dn = [NAN if _na(bb_mid[i]) else bb_mid[i] - bb_mult * bb_sd[i]
             for i in range(n)]

    # noise gauge: closes crossing the basis
    n_evt = [1 if x else 0 for x in ta.cross(c, basis)]
    n_val = ta.rolling_sum(n_evt, n_len)  # na until n_len bars (Pine math.sum)

    # historical volatility
    log_ret = [0.0] * n
    for i in range(1, n):
        log_ret[i] = math.log(c[i] / c[i - 1])
    hv_sd = ta.stdev(log_ret, 21)
    hv_val = [NAN if _na(x) else x * math.sqrt(252.0) * 100.0 for x in hv_sd]
    hv_rank = ta.percentrank(hv_val, 252)

    # overlay pack (alert-only in the Pine; computed regardless of toggles)
    st_fast, dir_fast = ta.supertrend(h, l, c, 2.0, 10)
    st_slow, dir_slow = ta.supertrend(h, l, c, 3.5, 21)
    hh20, ll20 = ta.highest(h, 20), ta.lowest(l, 20)
    hh50, ll50 = ta.highest(h, 50), ta.lowest(l, 50)
    mac_fast = [NAN if (_na(hh20[i]) or _na(ll20[i]))
                else (hh20[i] + ll20[i]) / 2.0 for i in range(n)]
    mac_slow = [NAN if (_na(hh50[i]) or _na(ll50[i]))
                else (hh50[i] + ll50[i]) / 2.0 for i in range(n)]
    # macBull: bool once both sides defined, None (Pine na-bool) before
    mac_bull = [None if (_na(mac_fast[i]) or _na(mac_slow[i]))
                else mac_fast[i] >= mac_slow[i] for i in range(n)]
    z_anchor = ta.sma(c, 100)
    z_atr = ta.atr(h, l, c, 50)
    z_u1 = [NAN if (_na(z_anchor[i]) or _na(z_atr[i]))
            else z_anchor[i] + 4.0 * z_atr[i] for i in range(n)]
    z_l1 = [NAN if (_na(z_anchor[i]) or _na(z_atr[i]))
            else z_anchor[i] - 4.0 * z_atr[i] for i in range(n)]
    z_enter_up = ta.crossover(c, z_u1)
    z_enter_dn = ta.crossunder(c, z_l1)

    # ── path-dependent walk, exact Pine block order per bar ──────────
    up_streak = 0
    dn_streak = 0
    is_bull = None            # tri-state: None until first streak completes
    last_flip_bar = None
    flip_bars = []
    prior_streak_at_flip = None   # regime length ended by the LAST flip
    last_rearm_b = -9999
    run_low = run_high = NAN
    prev_low = prev_high = NAN
    t1 = t2 = t3 = NAN
    h1 = h2 = h3 = False
    dir_state = 0
    trail_val = NAN
    stopped = False
    regime_age = 0

    ev = {}
    dbg_events = []
    dbg_trail = []
    dbg_bull = []
    dbg_dir = []

    for i in range(n):
        ev = {k: False for k in _EVENT_KEYS}

        # ── 2. sticky regime ─────────────────────────────────────────
        prev_bull = is_bull
        up_streak = up_streak + 1 if ta.gt(c[i], th_up[i]) else 0
        dn_streak = dn_streak + 1 if ta.lt(c[i], th_dn[i]) else 0
        if i == 0:
            is_bull = None  # close > na(basis) -> na
        elif up_streak >= confirm_n:
            is_bull = True
        elif dn_streak >= confirm_n:
            is_bull = False
        prev_bull_b = prev_bull is True  # Pine bool(na) = false
        flip_green = (is_bull is True) and not prev_bull_b
        flip_red = (is_bull is False) and prev_bull_b
        sig_buy, sig_sell = flip_green, flip_red
        ev["sig_buy"], ev["sig_sell"] = sig_buy, sig_sell

        # ── 3. volume grade ──────────────────────────────────────────
        strong = high_vol[i]
        if sig_buy or sig_sell:
            ev["strong"] = strong

        # flip bookkeeping (barssince: 0 on the flip bar itself)
        if sig_buy or sig_sell:
            prior_streak_at_flip = (i - flip_bars[-1]) if flip_bars else i
            flip_bars.append(i)
            last_flip_bar = i
        flip_age = (i - last_flip_bar) if last_flip_bar is not None else 9999

        # ── 4. continuation triangles ────────────────────────────────
        low3 = min(l[i - 2:i + 1]) if i >= 2 else NAN    # ta.lowest(low, 3)
        high3 = max(h[i - 2:i + 1]) if i >= 2 else NAN   # ta.highest(high, 3)
        c1 = c[i - 1] if i > 0 else NAN
        rearm_up_raw = ((is_bull is True) and flip_age >= 3
                        and ta.le(low3, basis[i])
                        and ta.ge(c[i], th_up[i]) and ta.lt(c1, th_up[i])
                        and c[i] > o[i])
        rearm_dn_raw = ((is_bull is False) and flip_age >= 3
                        and ta.ge(high3, basis[i])
                        and ta.le(c[i], th_dn[i]) and ta.gt(c1, th_dn[i])
                        and c[i] < o[i])
        rearm_up = rearm_up_raw and (i - last_rearm_b >= 8)
        rearm_dn = rearm_dn_raw and (i - last_rearm_b >= 8)
        if rearm_up or rearm_dn:
            last_rearm_b = i
        ev["rearm_up"], ev["rearm_dn"] = rearm_up, rearm_dn

        # ── 5. regime-run extremes (fib anchors) ─────────────────────
        if sig_buy or sig_sell:
            prev_low = min(ta.nz(run_low, l[i]), l[i])
            prev_high = max(ta.nz(run_high, h[i]), h[i])
            run_low = l[i]
            run_high = h[i]
        else:
            run_low = min(ta.nz(run_low, l[i]), l[i])
            run_high = max(ta.nz(run_high, h[i]), h[i])

        # ── 6. target ladder ─────────────────────────────────────────
        if sig_sell:
            dir_state = -1
            leg_ok = (not _na(prev_high)) and prev_high > c[i]
            leg = (prev_high - c[i]) if leg_ok else 2.0 * atr14[i]
            t1 = c[i] - FIB1 * leg
            t2 = c[i] - FIB2 * leg
            t3 = c[i] - FIB3 * leg
            h1 = ta.le(t1, 0.0)  # zero-floor guard, shorts only
            h2 = ta.le(t2, 0.0)
            h3 = ta.le(t3, 0.0)
        if sig_buy:
            dir_state = 1
            leg_ok = (not _na(prev_low)) and c[i] > prev_low
            leg = (c[i] - prev_low) if leg_ok else 2.0 * atr14[i]
            t1 = c[i] + FIB1 * leg
            t2 = c[i] + FIB2 * leg
            t3 = c[i] + FIB3 * leg
            h1 = h2 = h3 = False  # no guard on longs (as-coded)
        if dir_state == 1 and not sig_buy:
            if not h1 and ta.ge(h[i], t1):
                h1 = True
                ev["hit1"] = True
            if not h2 and ta.ge(h[i], t2):
                h2 = True
                ev["hit2"] = True
            if not h3 and ta.ge(h[i], t3):
                h3 = True
                ev["hit3"] = True
        if dir_state == -1 and not sig_sell:
            if not h1 and ta.le(l[i], t1):
                h1 = True
                ev["hit1"] = True
            if not h2 and ta.le(l[i], t2):
                h2 = True
                ev["hit2"] = True
            if not h3 and ta.le(l[i], t3):
                h3 = True
                ev["hit3"] = True

        # ── 7. chandelier trailing stop ──────────────────────────────
        atr_safe = ta.nz(atr14[i], h[i] - l[i])
        if rearm_up or rearm_dn:
            stopped = False
        if _na(trail_val):
            # ternary with na isBull -> false branch (short side)
            trail_val = (run_high - trail_mult * atr_safe) if is_bull is True \
                else (run_low + trail_mult * atr_safe)
        if flip_green:
            trail_val = run_high - trail_mult * atr_safe
            stopped = False
        elif flip_red:
            trail_val = run_low + trail_mult * atr_safe
            stopped = False
        elif is_bull is True:
            trail_val = max(trail_val, run_high - trail_mult * atr_safe)
            if not stopped and c[i] < trail_val:
                ev["exit_long"] = True
                stopped = True
        else:  # bear OR still-None regime (Pine else catches na)
            trail_val = min(trail_val, run_low + trail_mult * atr_safe)
            if not stopped and c[i] > trail_val:
                ev["exit_short"] = True
                stopped = True

        # ── 8. exhaustion (hidden Bollinger, open/close semantics) ───
        drop_pct = (o[i] - c[i]) / o[i] * 100.0 if o[i] > 0 else 0.0
        rise_pct = (c[i] - o[i]) / o[i] * 100.0 if o[i] > 0 else 0.0
        ev["exhaust_up"] = ((is_bull is True) and ta.gt(o[i], bb_up[i])
                            and (ta.lt(c[i], bb_up[i]) or drop_pct >= rev_pct))
        ev["exhaust_dn"] = ((is_bull is False) and ta.lt(o[i], bb_dn[i])
                            and (ta.gt(c[i], bb_dn[i]) or rise_pct >= rev_pct))

        # ── 9. gauges ────────────────────────────────────────────────
        regime_age = 0 if (flip_green or flip_red) else regime_age + 1

        # ── 10. overlay events ───────────────────────────────────────
        if i > 0:
            fu, fu1 = dir_fast[i] < 0, dir_fast[i - 1] < 0
            su, su1 = dir_slow[i] < 0, dir_slow[i - 1] < 0
            ev["st_fast_flip_up"] = fu and not fu1
            ev["st_fast_flip_dn"] = (not fu) and fu1
            ev["st_slow_flip_up"] = su and not su1
            ev["st_slow_flip_dn"] = (not su) and su1
            ev["macro_flip"] = (mac_bull[i] is not None
                                and mac_bull[i - 1] is not None
                                and mac_bull[i] != mac_bull[i - 1])
        ev["zone_enter_up"] = z_enter_up[i]
        ev["zone_enter_dn"] = z_enter_dn[i]

        if debug:
            fired = [k for k, x in ev.items() if x]
            if fired:
                dbg_events.append({"bar": i, "events": fired})
            dbg_trail.append(trail_val)
            dbg_bull.append(is_bull)
            dbg_dir.append(dir_state)

    # ── last-bar report ──────────────────────────────────────────────
    last = n - 1
    flipped_today = ev["sig_buy"] or ev["sig_sell"]

    next_target = None
    if dir_state != 0:
        rungs = [(1, t1, h1), (2, t2, h2), (3, t3, h3)]
        unhit = [(k, t) for k, t, hit in rungs if not hit]
        if not unhit:
            next_target = "All hit"
        else:
            k, t = unhit[0]
            next_target = None if _na(t) else "T{} · {:g}".format(k, round(t, 4))

    if _na(n_val[last]):
        noise_verdict = "TRENDING"  # Pine: na >= n_thresh -> false
    else:
        noise_verdict = "CHOPPY" if n_val[last] >= n_thresh else "TRENDING"

    if _na(hv_rank[last]):
        hv_tag = None
    elif hv_rank[last] > 70:
        hv_tag = "HIGH"
    elif hv_rank[last] < 30:
        hv_tag = "LOW"
    else:
        hv_tag = "NORMAL"

    price = c[last]
    pvb = None
    if not _na(basis[last]) and basis[last] != 0:
        pvb = (price - basis[last]) / basis[last] * 100.0

    result = {
        "bars": n,
        "close": _jf(price),
        "regime": "bull" if is_bull is True else ("bear" if is_bull is False else None),
        "regime_age": regime_age,
        "flipped_today": flipped_today,
        "flip_strong": ev["strong"] if flipped_today else False,
        "prior_streak": prior_streak_at_flip if flipped_today else None,
        "basis": _jf(basis[last]),
        "price_vs_basis_pct": _jf(pvb, 4),
        "above_basis": ta.gt(price, basis[last]),
        "thresh_upper": _jf(th_up[last]),
        "thresh_lower": _jf(th_dn[last]),
        "half_width": _jf(half[last]),
        "trail": _jf(trail_val),
        "stopped": stopped,
        "dir": dir_state,
        "t1": _jf(t1), "t2": _jf(t2), "t3": _jf(t3),
        "h1": h1, "h2": h2, "h3": h3,
        "next_target": next_target,
        "run_high": _jf(run_high), "run_low": _jf(run_low),
        "prev_high": _jf(prev_high), "prev_low": _jf(prev_low),
        "vol_z": _jf(vol_z[last], 4),
        "vol_hot": ta.ge(vol_z[last], vol_sigma),
        "noise": {"n_val": None if _na(n_val[last]) else int(n_val[last]),
                  "verdict": noise_verdict},
        "hv": {"value": _jf(hv_val[last], 2),
               "rank": _jf(hv_rank[last], 2),
               "tag": hv_tag},
        "overlays": {
            "st_fast_up": dir_fast[last] < 0,
            "st_slow_up": dir_slow[last] < 0,
            "st_fast_val": _jf(st_fast[last]),
            "st_slow_val": _jf(st_slow[last]),
            "macro_bull": mac_bull[last],
            "zone_upper": _jf(z_u1[last]),
            "zone_lower": _jf(z_l1[last]),
        },
        "events": ev,
    }
    if debug:
        result["debug"] = {
            "flip_bars": flip_bars,
            "events_history": dbg_events,
            "trail_series": dbg_trail,
            "bull_series": dbg_bull,
            "dir_series": dbg_dir,
        }
    return result


# ── self-test ────────────────────────────────────────────────────────

if __name__ == "__main__":
    import json
    import random

    rng = random.Random(11)
    o_, h_, l_, c_, v_ = [], [], [], [], []
    price = [100.0]

    def seg(nbars, drift, wobble=0.4, vol_base=1_000_000.0):
        for k in range(nbars):
            op = price[0]
            cl = op + drift + rng.uniform(-wobble, wobble)
            hi = max(op, cl) + rng.uniform(0.05, 0.9)
            lo = min(op, cl) - rng.uniform(0.05, 0.9)
            vol = vol_base * (1.0 + rng.uniform(-0.3, 0.3))
            if k % 17 == 0:
                vol *= 2.5  # periodic volume spikes -> some strong flips
            o_.append(op); h_.append(hi); l_.append(lo)
            c_.append(cl); v_.append(vol)
            price[0] = cl

    seg(160, +0.6)          # uptrend
    seg(110, -0.7)          # downtrend
    seg(120, 0.0, wobble=1.2)  # chop
    seg(60, +0.8)           # final uptrend

    N = len(c_)
    res = scan(o_, h_, l_, c_, v_, debug=True)
    dbg = res["debug"]

    # 1. JSON-clean output (no NaN anywhere)
    public = {k: x for k, x in res.items() if k != "debug"}
    json.dumps(public, allow_nan=False)

    # 2. Flips happened, none during warmup, and types strictly alternate
    flips = dbg["flip_bars"]
    assert len(flips) >= 3, "expected several regime flips, got %r" % flips
    assert flips[0] >= 33, "flip before warmup completes: %r" % flips[0]
    kinds = []
    for entry in dbg["events_history"]:
        if "sig_buy" in entry["events"]:
            kinds.append("B")
        elif "sig_sell" in entry["events"]:
            kinds.append("S")
    assert len(kinds) == len(flips)
    for a, b in zip(kinds, kinds[1:]):
        assert a != b, "flips must strictly alternate: %r" % kinds
    assert kinds[0] == "B", "uptrend start must fire the first (green) flip"

    # 3. Regime tracks the segments
    r_up = scan(o_[:160], h_[:160], l_[:160], c_[:160], v_[:160])
    assert r_up["regime"] == "bull", r_up["regime"]
    r_dn = scan(o_[:270], h_[:270], l_[:270], c_[:270], v_[:270])
    assert r_dn["regime"] == "bear", r_dn["regime"]
    assert res["regime"] == "bull", res["regime"]  # final uptrend

    # 4. Events only under defined conditions
    flipset = set(flips)
    for entry in dbg["events_history"]:
        i, evs = entry["bar"], set(entry["events"])
        if {"hit1", "hit2", "hit3"} & evs:
            assert dbg["dir_series"][i] != 0, "hit with no ladder at bar %d" % i
            assert i not in flipset, "hit on its own flip bar %d" % i
        if "exit_long" in evs:
            assert dbg["bull_series"][i] is True, "exit_long outside bull at %d" % i
        if "exit_short" in evs:
            assert dbg["bull_series"][i] is not True, "exit_short in bull at %d" % i
        if "exhaust_up" in evs:
            assert dbg["bull_series"][i] is True
        if "exhaust_dn" in evs:
            assert dbg["bull_series"][i] is False
        assert not ({"sig_buy"} <= evs and {"sig_sell"} <= evs)

    # 5. Trail ratchet only tightens between flips
    for i in range(1, N):
        if i in flipset:
            continue
        tprev, tcur = dbg["trail_series"][i - 1], dbg["trail_series"][i]
        if _na(tprev) or _na(tcur):
            continue
        if dbg["bull_series"][i] is True and dbg["bull_series"][i - 1] is True:
            assert tcur >= tprev - 1e-9, "bull trail loosened at bar %d" % i
        if dbg["bull_series"][i] is not True and dbg["bull_series"][i - 1] is not True:
            assert tcur <= tprev + 1e-9, "bear trail loosened at bar %d" % i

    # 6. flipped_today / prior_streak on a prefix ending exactly at a flip
    F = flips[-1]
    r_flip = scan(o_[:F + 1], h_[:F + 1], l_[:F + 1], c_[:F + 1], v_[:F + 1])
    assert r_flip["flipped_today"] is True
    assert isinstance(r_flip["prior_streak"], int) and r_flip["prior_streak"] >= 1
    assert r_flip["prior_streak"] == F - flips[-2]
    assert r_flip["regime_age"] == 0
    assert res["flipped_today"] is False or res["prior_streak"] is not None

    # 7. Warmup safety: tiny input runs clean, regime None, JSON-clean
    r_tiny = scan(o_[:5], h_[:5], l_[:5], c_[:5], v_[:5])
    json.dumps(r_tiny, allow_nan=False)
    assert r_tiny["regime"] is None
    assert r_tiny["basis"] is None
    assert r_tiny["dir"] == 0 and r_tiny["next_target"] is None
    assert r_tiny["trail"] is not None  # seeds bar 0 (na-proof atrSafe)

    # 8. Ladder sanity on the final (bull) leg
    assert res["dir"] == 1
    if res["next_target"] not in (None, "All hit"):
        assert res["next_target"].startswith("T")
    assert res["basis"] is not None and res["thresh_upper"] > res["thresh_lower"]
    assert res["noise"]["verdict"] in ("CHOPPY", "TRENDING")
    assert res["hv"]["tag"] in ("HIGH", "LOW", "NORMAL", None)

    n_events = sum(len(e["events"]) for e in dbg["events_history"])
    print("SELF-TEST PASSED")
    print("bars=%d flips=%r kinds=%s total_event_flags=%d" %
          (N, flips, "".join(kinds), n_events))
    print("last bar:", json.dumps({k: public[k] for k in
          ("regime", "regime_age", "flipped_today", "basis",
           "price_vs_basis_pct", "trail", "stopped", "dir", "next_target")}))
