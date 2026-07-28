"""Shared Pine ta.* helpers — bar-for-bar Pine v6 semantics, pure stdlib.

Conventions (see porting notes):
- Series are plain Python lists of float; float('nan') marks Pine `na`.
- Every function returns a list the SAME LENGTH as its input, nan-padded
  through warmup.
- ta.ema seeds with the FIRST non-na value of src (ema = src on that bar).
- ta.rma (inside ATR/RSI) seeds with the SMA of the first n non-na values.
- ta.stdev is POPULATION stdev (Pine default biased=true).
- Pivots confirm `right` bars after the extreme; ties invalidate (strict).
- percentile_linear_interpolation = Excel PERCENTILE.INC over the last n
  values INCLUDING the current bar.
"""

import math

NAN = float("nan")


def is_na(x):
    """Pine na test: None or nan."""
    return x is None or (isinstance(x, float) and math.isnan(x))


# ── nan-safe comparisons (Pine: a nan condition is FALSE) ─────────────

def nz(x, repl=0.0):
    """Pine nz(x, repl): repl when x is na, else x."""
    return repl if is_na(x) else x


def gt(a, b):
    return (not is_na(a)) and (not is_na(b)) and a > b


def lt(a, b):
    return (not is_na(a)) and (not is_na(b)) and a < b


def ge(a, b):
    return (not is_na(a)) and (not is_na(b)) and a >= b


def le(a, b):
    return (not is_na(a)) and (not is_na(b)) and a <= b


# ── moving averages ───────────────────────────────────────────────────

def sma(src, n):
    """ta.sma: mean of last n values; na until n non-na values; na inputs
    propagate (any na in the window -> na)."""
    m = len(src)
    out = [NAN] * m
    s = 0.0
    nan_cnt = 0
    for i in range(m):
        x = src[i]
        if is_na(x):
            nan_cnt += 1
        else:
            s += x
        if i >= n:
            y = src[i - n]
            if is_na(y):
                nan_cnt -= 1
            else:
                s -= y
        if i >= n - 1 and nan_cnt == 0:
            out[i] = s / n
    return out


def ema(src, n):
    """ta.ema: alpha = 2/(n+1), SEEDED with the first non-na src value."""
    m = len(src)
    out = [NAN] * m
    alpha = 2.0 / (n + 1)
    prev = None
    for i in range(m):
        x = src[i]
        if is_na(x):
            continue  # out stays nan; state unchanged
        if prev is None:
            prev = x
        else:
            prev = alpha * x + (1.0 - alpha) * prev
        out[i] = prev
    return out


def rma(src, n):
    """ta.rma: alpha = 1/n; na until n non-na values, then seeded with
    their SMA, recursive after."""
    m = len(src)
    out = [NAN] * m
    alpha = 1.0 / n
    buf_sum = 0.0
    buf_cnt = 0
    prev = None
    for i in range(m):
        x = src[i]
        if is_na(x):
            continue
        if prev is None:
            buf_sum += x
            buf_cnt += 1
            if buf_cnt == n:
                prev = buf_sum / n
                out[i] = prev
        else:
            prev = alpha * x + (1.0 - alpha) * prev
            out[i] = prev
    return out


def stdev(src, n):
    """ta.stdev: POPULATION stdev (ddof=0) over the last n values; na
    until the window is fully defined."""
    m = len(src)
    out = [NAN] * m
    for i in range(n - 1, m):
        w = src[i - n + 1:i + 1]
        if any(is_na(x) for x in w):
            continue
        mean = sum(w) / n
        out[i] = math.sqrt(sum((x - mean) ** 2 for x in w) / n)
    return out


# ── volatility / oscillators ──────────────────────────────────────────

def true_range(high, low, close):
    """TR = max(H-L, |H-C[1]|, |L-C[1]|); bar 0 TR = H-L."""
    m = len(close)
    out = [NAN] * m
    for i in range(m):
        if i == 0:
            out[i] = high[i] - low[i]
        else:
            out[i] = max(high[i] - low[i],
                         abs(high[i] - close[i - 1]),
                         abs(low[i] - close[i - 1]))
    return out


def atr(high, low, close, n):
    """ta.atr: RMA of True Range; non-na from bar index n-1."""
    return rma(true_range(high, low, close), n)


def rsi(src, n):
    """ta.rsi: u = max(d,0), d = max(-d,0), delta = src - src[1];
    RSI = 100 * rma_u / (rma_u + rma_d); 0/0 -> na (rma_d==0 -> 100)."""
    m = len(src)
    u = [NAN] * m
    d = [NAN] * m
    prev = None
    for i in range(m):
        x = src[i]
        if is_na(x):
            continue
        if prev is not None:
            delta = x - prev
            u[i] = max(delta, 0.0)
            d[i] = max(-delta, 0.0)
        prev = x
    ru = rma(u, n)
    rd = rma(d, n)
    out = [NAN] * m
    for i in range(m):
        if is_na(ru[i]) or is_na(rd[i]):
            continue
        denom = ru[i] + rd[i]
        out[i] = NAN if denom == 0.0 else 100.0 * ru[i] / denom
    return out


def mfi(src, volume, n):
    """ta.mfi: rolling SIMPLE SUM (math.sum, not RMA) over n bars of
    volume*src split by sign of src - src[1]; ties count in neither side;
    MFI = 100 * pos / (pos + neg); pos+neg == 0 -> na."""
    m = len(src)
    pos = [NAN] * m
    neg = [NAN] * m
    for i in range(1, m):
        if is_na(src[i]) or is_na(src[i - 1]) or is_na(volume[i]):
            continue
        mf = volume[i] * src[i]
        pos[i] = mf if src[i] > src[i - 1] else 0.0
        neg[i] = mf if src[i] < src[i - 1] else 0.0
    out = [NAN] * m
    for i in range(n - 1, m):
        wp = pos[i - n + 1:i + 1]
        wn = neg[i - n + 1:i + 1]
        if any(is_na(x) for x in wp) or any(is_na(x) for x in wn):
            continue
        p = sum(wp)
        q = sum(wn)
        tot = p + q
        out[i] = NAN if tot == 0.0 else 100.0 * p / tot
    return out


# ── pivots ────────────────────────────────────────────────────────────

def pivothigh(src, left, right):
    """ta.pivothigh: candidate = src[right]; confirmed on the current bar
    iff STRICTLY greater than all `left` values before and all `right`
    values after (ties invalidate). Value emitted on the confirmation bar
    (right bars after the extreme); nan elsewhere. na in window -> no
    pivot."""
    m = len(src)
    out = [NAN] * m
    for i in range(left + right, m):
        j = i - right
        v = src[j]
        if is_na(v):
            continue
        ok = True
        for k in range(j - left, i + 1):
            if k == j:
                continue
            x = src[k]
            if is_na(x) or x >= v:
                ok = False
                break
        if ok:
            out[i] = v
    return out


def pivotlow(src, left, right):
    """ta.pivotlow — mirror of pivothigh (strictly less than both sides)."""
    m = len(src)
    out = [NAN] * m
    for i in range(left + right, m):
        j = i - right
        v = src[j]
        if is_na(v):
            continue
        ok = True
        for k in range(j - left, i + 1):
            if k == j:
                continue
            x = src[k]
            if is_na(x) or x <= v:
                ok = False
                break
        if ok:
            out[i] = v
    return out


# ── percentile ────────────────────────────────────────────────────────

def percentile_linear_interpolation(src, n, p):
    """ta.percentile_linear_interpolation: Excel PERCENTILE.INC over the
    last n values INCLUDING the current bar. Sort window, rank
    r = p/100*(n-1), linear interpolation between neighbors. na until the
    window holds n defined values."""
    m = len(src)
    out = [NAN] * m
    for i in range(n - 1, m):
        w = src[i - n + 1:i + 1]
        if any(is_na(x) for x in w):
            continue
        s = sorted(w)
        r = p / 100.0 * (n - 1)
        lo = int(math.floor(r))
        hi = int(math.ceil(r))
        out[i] = s[lo] if lo == hi else s[lo] + (r - lo) * (s[hi] - s[lo])
    return out


def percentrank(src, n):
    """ta.percentrank: 100 * count(PREVIOUS n values <= current) / n; the
    current bar is EXCLUDED from the window. na until n prior defined
    values exist (na in the window or na current -> na)."""
    m = len(src)
    out = [NAN] * m
    for i in range(n, m):
        if is_na(src[i]):
            continue
        w = src[i - n:i]
        if any(is_na(x) for x in w):
            continue
        out[i] = 100.0 * sum(1 for x in w if x <= src[i]) / n
    return out


# ── rolling windows ───────────────────────────────────────────────────

def highest(src, n):
    """ta.highest: max over the last n bars INCLUDING the current one; na
    until the window holds n defined values."""
    m = len(src)
    out = [NAN] * m
    for i in range(n - 1, m):
        w = src[i - n + 1:i + 1]
        if any(is_na(x) for x in w):
            continue
        out[i] = max(w)
    return out


def lowest(src, n):
    """ta.lowest: min over the last n bars INCLUDING the current one."""
    m = len(src)
    out = [NAN] * m
    for i in range(n - 1, m):
        w = src[i - n + 1:i + 1]
        if any(is_na(x) for x in w):
            continue
        out[i] = min(w)
    return out


def rolling_sum(src, n):
    """math.sum: rolling sum of the last n values; na until n values."""
    m = len(src)
    out = [NAN] * m
    for i in range(n - 1, m):
        w = src[i - n + 1:i + 1]
        if any(is_na(x) for x in w):
            continue
        out[i] = sum(w)
    return out


# ── crosses ───────────────────────────────────────────────────────────

def crossover(a, b):
    """ta.crossover: a>b and a[1]<=b[1]; any na -> False."""
    m = len(a)
    out = [False] * m
    for i in range(1, m):
        out[i] = gt(a[i], b[i]) and le(a[i - 1], b[i - 1])
    return out


def crossunder(a, b):
    """ta.crossunder: a<b and a[1]>=b[1]; any na -> False."""
    m = len(a)
    out = [False] * m
    for i in range(1, m):
        out[i] = lt(a[i], b[i]) and ge(a[i - 1], b[i - 1])
    return out


def cross(a, b):
    """ta.cross = crossover or crossunder."""
    up = crossover(a, b)
    dn = crossunder(a, b)
    return [up[i] or dn[i] for i in range(len(a))]


# ── supertrend ────────────────────────────────────────────────────────

def supertrend(high, low, close, factor, n):
    """ta.supertrend(factor, n): TV reference implementation on hl2 with
    RMA-ATR(n). Returns (line, direction) lists; direction -1 = uptrend,
    +1 = downtrend. Warmup follows the reference: nz(band[1]) -> 0 and
    direction 1 while ATR[1] is na."""
    m = len(close)
    a = atr(high, low, close, n)
    line = [NAN] * m
    direction = [1] * m
    prev_lower = 0.0  # nz(lowerBand[1])
    prev_upper = 0.0  # nz(upperBand[1])
    prev_st = NAN
    for i in range(m):
        src = (high[i] + low[i]) / 2.0
        if is_na(a[i]):
            up_band, lo_band = NAN, NAN
        else:
            up_band = src + factor * a[i]
            lo_band = src - factor * a[i]
        c1 = close[i - 1] if i > 0 else NAN
        lo_f = lo_band if (gt(lo_band, prev_lower) or lt(c1, prev_lower)) else prev_lower
        up_f = up_band if (lt(up_band, prev_upper) or gt(c1, prev_upper)) else prev_upper
        atr_prev = a[i - 1] if i > 0 else NAN
        if is_na(atr_prev):
            di = 1
        elif prev_st == prev_upper:
            di = -1 if gt(close[i], up_f) else 1
        else:
            di = 1 if lt(close[i], lo_f) else -1
        line[i] = lo_f if di == -1 else up_f
        direction[i] = di
        prev_lower, prev_upper, prev_st = lo_f, up_f, line[i]
    return line, direction
