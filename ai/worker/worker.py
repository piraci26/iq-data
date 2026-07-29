#!/usr/bin/env python3
"""IQ Algo reads worker.

Watches the IQ scan output (iq/scan.json), fingerprints each ticker's ENGINE
STATE (signals, not prices), diffs against the previously persisted state, logs
every state change to state/events.jsonl, and asks the LLM for a 2-3 sentence
"read" in the IQ voice for every NEW or CHANGED ticker. Reads land in
out/reads.json as {ticker: {read, updated_at, state_hash}}.

DATA SOURCE (the repo's own scanner, scanner.py -> docs/iq/scan.json):
  {"updated_at": iso, "tickers": {SYM: {"name":.., "mcap":.., "price":..,
      "d": {"bands": {...}, "osc": {...}, "structure": {...}},
      "w": {...}, "m": {...}}}}
  where each product block is (a possibly trimmed form of) the corresponding
  engines/{bands,oscillator,structure}.py scan() result. ALL raw field access
  is isolated in extract_ticker() — if the scanner's field names drift, that
  one function is the only thing to fix.

FINGERPRINT DESIGN (state-defining fields only, never prices/values):
- Per ticker, per timeframe:
    bands regime (bull/bear), osc side (bull/bear) + stretched hi/lo flags,
    structure direction (internal + major) + today's structure events.
- Deliberately EXCLUDED: price, basis, wave magnitude, wave slope, flow value,
  wave-vs-signal — these flicker on the scan cadence and would spam events +
  LLM calls. They still appear in the facts payload handed to the LLM.
- Removal (ticker leaves the scan universe) is logged to events.jsonl but does
  NOT trigger an LLM read; the last read is kept in reads.json.

LLM: OpenAI-compatible chat completions. Env-configurable so dev (Ollama) and
prod (DeepInfra/Groq/Anthropic) are a pure env swap:
  LLM_BASE_URL  default http://localhost:11434/v1
  LLM_MODEL     default llama3.1:8b
  LLM_API_KEY   default "ollama"
  LLM_TIMEOUT   default 60 (seconds per request)
  SCAN_BASE     default https://piraci26.github.io/iq-data (URL or local dir;
                the worker appends /iq/scan.json; CI sets SCAN_BASE=docs to
                read the scanner output produced earlier in the same job)
  MAX_READS_PER_PASS  default 25 (changed-first, then mcap-desc; rest retry)

Prompt text comes from ../prompts/read.txt when present; a built-in fallback
keeps the worker functional if the prompts are missing. The prompts/ files are
completion-style templates ({{STATE_JSON}} etc.): when the placeholder is
present the worker fills it and sends the whole template as a single user
message; otherwise the file is used as the system prompt with the facts block
as the user message.

CLI:
  python3 worker.py --once
  python3 worker.py --loop --interval 300
"""

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------- paths

WORKER_DIR = Path(__file__).resolve().parent
STATE_DIR = WORKER_DIR / "state"
OUT_DIR = WORKER_DIR / "out"
PROMPTS_DIR = WORKER_DIR.parent / "prompts"

STATE_FILE = STATE_DIR / "last_states.json"
EVENTS_FILE = STATE_DIR / "events.jsonl"
READS_FILE = OUT_DIR / "reads.json"

# --------------------------------------------------------------------------- config

# .strip() everywhere: secrets pasted into CI/UI fields often carry a stray
# trailing newline, which turns into a 401 that looks like a bad key.
SCAN_BASE = os.environ.get("SCAN_BASE", "https://piraci26.github.io/iq-data").strip()
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://localhost:11434/v1").strip()
LLM_MODEL = os.environ.get("LLM_MODEL", "llama3.1:8b").strip()
LLM_MODEL_FALLBACK = os.environ.get("LLM_MODEL_FALLBACK", "").strip()
LLM_API_KEY = os.environ.get("LLM_API_KEY", "ollama").strip()
LLM_TIMEOUT = float(os.environ.get("LLM_TIMEOUT", "60"))
MAX_READS_PER_PASS = int(os.environ.get("MAX_READS_PER_PASS", "25"))
FETCH_TIMEOUT = float(os.environ.get("FETCH_TIMEOUT", "30"))

SCAN_FILE = "iq/scan.json"

# scan.json timeframe keys -> the names used in fingerprints, events, prompts
TF_KEYS = {"daily": "d", "weekly": "w", "monthly": "m"}
TIMEFRAMES = list(TF_KEYS.keys())

# Fingerprint fields, in diff order (see extract_ticker for their meaning).
FP_FIELDS = ("bands", "osc", "osc_hi", "osc_lo",
             "struct", "struct_major", "struct_events")

# Consecutive LLM failures before we stop trying for the rest of the pass.
LLM_FAIL_LIMIT = 3

FALLBACK_READ_PROMPT = """\
You write short "reads" for the IQ Algo scanner (IQ Bands = trend regime,
IQ Oscillator = momentum, IQ Structure = price action). Voice: professional
trader shorthand. No hype, no emojis, no financial advice -- say "the scan
shows X", never "you should buy".
Vocabulary: trend regime (bullish/bearish, flips), momentum wave and signal,
money flow (buy side/sell side), stretched/extreme, confluence n/4, BOS,
CHoCH, EQH/EQL sweep.
Given the engine-state facts for one ticker, write a 2-3 sentence read that a
trader can absorb in five seconds. Use ONLY the facts provided -- never invent
signals, levels, or confluence counts that are not listed. Lead with the most
significant signal; the daily timeframe is primary. Cite at most two numbers.
Output only the read text, no preamble, no quotes."""


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print("[%s] %s" % (ts, msg), flush=True)


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------- prompts


def load_prompt(filename, fallback):
    """Read a prompt from ../prompts/, falling back to a built-in string."""
    path = PROMPTS_DIR / filename
    try:
        text = path.read_text(encoding="utf-8").strip()
        if text:
            return text
    except OSError:
        pass
    return fallback


# --------------------------------------------------------------------------- LLM


def make_client():
    """Build the OpenAI-compatible client, or return None if unavailable."""
    try:
        from openai import OpenAI
    except ImportError:
        log("openai package not installed -- reads will be skipped "
            "(pip install -r requirements.txt)")
        return None
    return OpenAI(base_url=LLM_BASE_URL, api_key=LLM_API_KEY, timeout=LLM_TIMEOUT)


def chat(client, system, user, max_tokens=220, temperature=0.4):
    """One chat completion. Raises on failure; callers decide how to degrade.

    system may be None/empty for single-message completion-style prompts.
    On a rate-limit error (provider daily/minute caps), retries once on
    LLM_MODEL_FALLBACK — hosted free tiers cap per model, so a second model
    keeps the pipeline flowing when the primary's budget is exhausted.
    """
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})

    def _run(model):
        resp = client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        return (resp.choices[0].message.content or "").strip().strip('"').strip()

    try:
        return _run(LLM_MODEL)
    except Exception as exc:
        fb = LLM_MODEL_FALLBACK
        rate_limited = "429" in str(exc) or type(exc).__name__ == "RateLimitError"
        if not fb or fb == LLM_MODEL or not rate_limited:
            raise
        log("rate-limited on %s -- falling back to %s" % (LLM_MODEL, fb))
        return _run(fb)


# --------------------------------------------------------------------------- scan loading


def load_scan():
    """Load iq/scan.json from SCAN_BASE (URL or local dir).

    Returns the parsed dict or None on any failure.
    """
    try:
        if SCAN_BASE.startswith("http://") or SCAN_BASE.startswith("https://"):
            url = SCAN_BASE.rstrip("/") + "/" + SCAN_FILE
            req = urllib.request.Request(url, headers={"User-Agent": "iq-algo-reads-worker"})
            with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as fh:
                data = json.loads(fh.read().decode("utf-8"))
        else:
            data = json.loads((Path(SCAN_BASE) / SCAN_FILE).read_text(encoding="utf-8"))
    except Exception as exc:  # network truncation raises non-OSError types
        # (e.g. http.client.IncompleteRead); a bad fetch must never kill a pass
        log("fetch failed for %s: %s" % (SCAN_FILE, exc))
        return None
    if not isinstance(data, dict) or not isinstance(data.get("tickers"), dict):
        log("unexpected payload shape for %s (no tickers dict) -- skipping" % SCAN_FILE)
        return None
    return data


# --------------------------------------------------------------------------- extraction
#
# EVERYTHING that touches raw scan.json field names lives in extract_ticker()
# and the tiny helpers right above it. Scanner field drift = fix here only.

def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _sub(d, key):
    """d[key] if it is a dict, else {} — tolerates missing product blocks."""
    v = d.get(key) if isinstance(d, dict) else None
    return v if isinstance(v, dict) else {}


def _state_of(block):
    """Engine outputs nest last-bar fields under "state" (oscillator,
    structure) or keep them flat (bands). Accept either."""
    inner = block.get("state")
    return inner if isinstance(inner, dict) else block


def _events_of(block, state):
    """Prefer the engine's events_fired list; fall back to truthy keys of an
    events dict. Checks both the outer block and the state level."""
    for src in (block, state):
        ev = src.get("events_fired")
        if isinstance(ev, list):
            return [e for e in ev if isinstance(e, str)]
    for src in (block, state):
        ev = src.get("events")
        if isinstance(ev, dict):
            return sorted(k for k, fired in ev.items() if fired)
    return []


def _dir_word(v):
    """structure struct_dir: 1 -> bull, -1 -> bear, 0/None -> None."""
    n = _num(v)
    if n is None or n == 0:
        return None
    return "bull" if n > 0 else "bear"


def extract_ticker(trow):
    """Normalize ONE ticker row of scan.json into internal fields.

    Returns {"meta": {name, mcap, price}, "tfs": {daily: {...}, ...}} using
    only internal key names; fingerprints and the LLM payload are both built
    from this, so scan.json field drift is a one-function fix.
    """
    norm = {"meta": {"name": trow.get("name"),
                     "mcap": _num(trow.get("mcap")),
                     "price": _num(trow.get("price"))},
            "tfs": {}}
    for tf, key in TF_KEYS.items():
        tfrow = trow.get(key)
        if not isinstance(tfrow, dict):
            continue
        bands = _state_of(_sub(tfrow, "bands"))
        osc_block = _sub(tfrow, "osc")
        osc = _state_of(osc_block)
        st_block = _sub(tfrow, "structure")
        st = _state_of(st_block)
        if not (bands or osc or st):
            continue

        regime = bands.get("regime")
        norm["tfs"][tf] = {
            # IQ Bands (trend)
            "regime": regime if regime in ("bull", "bear") else None,
            "regime_age": _num(bands.get("regime_age")),
            "flipped_today": bool(bands.get("flipped_today")),
            "flip_strong": bool(bands.get("flip_strong")),
            "prior_streak": _num(bands.get("prior_streak")),
            "price_vs_basis_pct": _num(bands.get("price_vs_basis_pct")),
            "noise": (bands.get("noise") or {}).get("verdict")
                     if isinstance(bands.get("noise"), dict) else bands.get("noise"),
            "vol_hot": bool(bands.get("vol_hot")),
            # IQ Oscillator (momentum)
            "osc_side": osc.get("side") if osc.get("side") in ("bull", "bear") else None,
            "wave": _num(osc.get("wave")),
            "wave_prev": _num(osc.get("wave_prev")),
            "wave_slope": osc.get("wave_slope"),
            "signal": _num(osc.get("signal")),
            "wave_vs_signal": osc.get("wave_vs_signal"),
            "flow_side": osc.get("flow_side"),
            "stretched_hi": bool(osc.get("stretched_hi")),
            "stretched_lo": bool(osc.get("stretched_lo")),
            "osc_events": _events_of(osc_block, osc),
            # IQ Structure (price action)
            "struct_dir": _dir_word(st.get("struct_dir")),
            "struct_dir_major": _dir_word(st.get("struct_dir_major")),
            "struct_events": _events_of(st_block, st),
        }
    return norm


def fingerprint_of(tf_norm):
    """State-defining fields only (see module docstring)."""
    return {
        "bands": tf_norm["regime"],
        "osc": tf_norm["osc_side"],
        "osc_hi": tf_norm["stretched_hi"],
        "osc_lo": tf_norm["stretched_lo"],
        "struct": tf_norm["struct_dir"],
        "struct_major": tf_norm["struct_dir_major"],
        "struct_events": sorted(tf_norm["struct_events"]),
    }


def extract_current(scan):
    """Build per-ticker fingerprints and facts from the fetched scan.

    Returns (fingerprints, facts, meta):
      fingerprints: {sym: {tf: {state-defining fields}}}
      facts:        {sym: {tf: normalized fields for the prompt}}
      meta:         {sym: {"name":.., "mcap":.., "price":..}}
    """
    fingerprints, facts, meta = {}, {}, {}
    for sym, trow in scan["tickers"].items():
        if not sym or not isinstance(trow, dict):
            continue
        norm = extract_ticker(trow)
        if not norm["tfs"]:
            continue
        meta[sym] = norm["meta"]
        facts[sym] = norm["tfs"]
        fingerprints[sym] = {tf: fingerprint_of(n) for tf, n in norm["tfs"].items()}
    return fingerprints, facts, meta


# --------------------------------------------------------------------------- state


def fingerprint_hash(fp):
    blob = json.dumps(fp, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def atomic_write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def append_events(events):
    if not events:
        return
    EVENTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with EVENTS_FILE.open("a", encoding="utf-8") as fh:
        for ev in events:
            fh.write(json.dumps(ev, separators=(",", ":")) + "\n")


def diff_fingerprints(old_fp, new_fp):
    """Flat field-level diff: [{"field": "daily.bands", "from": x, "to": y}]."""
    changes = []
    for tf in TIMEFRAMES:
        o = old_fp.get(tf) or {}
        n = new_fp.get(tf) or {}
        for field in FP_FIELDS:
            ov, nv = o.get(field), n.get(field)
            if ov != nv:
                changes.append({"field": "%s.%s" % (tf, field), "from": ov, "to": nv})
    return changes


# --------------------------------------------------------------------------- facts -> prompt payload

SIDE_WORD = {"bull": "bullish", "bear": "bearish"}

STRUCT_EVENT_WORDS = {
    "bos_up": "bullish BOS", "bos_dn": "bearish BOS",
    "choch_up": "bullish CHoCH", "choch_dn": "bearish CHoCH",
    "choch_up_plus": "bullish CHoCH+", "choch_dn_plus": "bearish CHoCH+",
    "maj_bos_up": "major bullish BOS", "maj_bos_dn": "major bearish BOS",
    "maj_choch_up": "major bullish CHoCH", "maj_choch_dn": "major bearish CHoCH",
    "maj_choch_up_plus": "major bullish CHoCH+",
    "maj_choch_dn_plus": "major bearish CHoCH+",
    "tl_break_up": "trendline break to the upside",
    "tl_break_dn": "trendline break to the downside",
    "sweep_hi": "EQH sweep", "sweep_lo": "EQL sweep",
}

OSC_EVENT_WORDS = {
    "flip_up": "bullish momentum flip", "flip_dn": "bearish momentum flip",
    "turn_up": "wave turn up", "turn_dn": "wave turn down",
    "rev_up": "reversal cross up", "rev_dn": "reversal cross down",
    "dual_long": "dual confirmation long", "dual_short": "dual confirmation short",
    "bull_div": "bullish divergence", "bear_div": "bearish divergence",
    "h_bull_div": "hidden bullish divergence",
    "h_bear_div": "hidden bearish divergence",
    "enter_hi": "entered the overbought zone",
    "enter_lo": "entered the oversold zone",
    # deliberately dropped from the payload (noise on every wobble):
    "turn_up_ungated": None, "turn_dn_ungated": None,
}


def _words(events, table):
    out = []
    for e in events:
        w = table.get(e, e)  # unknown events pass through raw, never lost
        if w:
            out.append(w)
    return out


def confluence(n):
    """The REAL bullish confluence count for one timeframe: bands regime bull
    + osc side bull + wave above signal + money flow buying => n/4."""
    score = int(n["regime"] == "bull")
    score += int(n["osc_side"] == "bull")
    score += int(n["wave_vs_signal"] == "above")
    score += int((n["flow_side"] or "").upper() == "BUYING")
    return "%d/4" % score


def _prune(d):
    """Drop None values and empty lists so the model never sees null fields
    (prompt rule: if a field is missing, do not mention it)."""
    return {k: v for k, v in d.items() if v is not None and v != []}


def render_facts(sym, tf_facts, meta):
    """Build the STATE payload (compact JSON) for the LLM, all three products
    in IQ vocabulary, per timeframe, daily primary."""
    payload = _prune({"sym": sym, "name": meta.get("name"),
                      "mcap": meta.get("mcap"), "price": meta.get("price")})
    for tf in TIMEFRAMES:
        n = tf_facts.get(tf)
        if not n:
            continue
        # No resolved regime (engine warm-up) -> no trend block at all; a
        # naked bars_in_regime with no side would invite hallucinated sides.
        trend = {} if not (n["regime"] or n["flipped_today"]) else _prune({
            "regime": SIDE_WORD.get(n["regime"]),
            "flipped_today": n["flipped_today"],
            "prior_opposite_bars": n["prior_streak"] if n["flipped_today"] else None,
            "bars_in_regime": None if n["flipped_today"] else n["regime_age"],
            "strong_flip": True if (n["flipped_today"] and n["flip_strong"]) else None,
            "price_vs_basis_pct": n["price_vs_basis_pct"],
            "noise": n["noise"].lower() if isinstance(n["noise"], str) else None,
            "volume_hot": True if n["vol_hot"] else None,
        })
        momentum = _prune({
            "side": SIDE_WORD.get(n["osc_side"]),
            "wave": n["wave"], "wave_prev": n["wave_prev"],
            "slope": n["wave_slope"],
            "signal": n["signal"], "wave_vs_signal": n["wave_vs_signal"],
            "stretched_high": True if n["stretched_hi"] else None,
            "stretched_low": True if n["stretched_lo"] else None,
            "events": _words(n["osc_events"], OSC_EVENT_WORDS),
        })
        structure = _prune({
            "direction": SIDE_WORD.get(n["struct_dir"]),
            "major_direction": SIDE_WORD.get(n["struct_dir_major"]),
            "events_today": _words(n["struct_events"], STRUCT_EVENT_WORDS),
        })
        block = _prune({
            "trend": trend or None,
            "momentum": momentum or None,
            "structure": structure or None,
            "money_flow": (n["flow_side"] or "").lower() or None,
            "confluence": confluence(n),
        })
        if block:
            payload[tf] = block
    return json.dumps(payload, separators=(",", ":"))


def generate_read(client, sym, tf_facts, meta):
    prompt = load_prompt("read.txt", FALLBACK_READ_PROMPT)
    facts = render_facts(sym, tf_facts, meta)
    if "{{STATE_JSON}}" in prompt:
        # prompts/read.txt is a completion-style template ending in
        # "STATE:\n{{STATE_JSON}}\nREAD:" — fill the slot and send the whole
        # thing as a single user message (few-shots stay adjacent to the data).
        return chat(client, None, prompt.replace("{{STATE_JSON}}", facts))
    return chat(client, prompt, facts)


# --------------------------------------------------------------------------- one pass


def run_pass(client):
    scan = load_scan()
    if scan is None:
        log("no scan data reachable this pass -- nothing to do")
        return

    current_fp, facts, meta = extract_current(scan)
    old_state = load_json(STATE_FILE, {})
    if not isinstance(old_state, dict):
        old_state = {}

    ts = now_iso()
    new_state = {}
    events = []

    for sym in sorted(set(old_state) | set(current_fp)):
        old_entry = old_state.get(sym) or {}
        old_fp = old_entry.get("fingerprint") or {}
        new_fp = current_fp.get(sym)

        if not new_fp:
            # Ticker left the scan universe: log the removal, drop the entry.
            if old_fp:
                events.append({"ts": ts, "ticker": sym,
                               "changes": diff_fingerprints(old_fp, {})})
            continue

        changes = diff_fingerprints(old_fp, new_fp)
        if changes:
            events.append({"ts": ts, "ticker": sym, "changes": changes})
        new_state[sym] = {
            "fingerprint": new_fp,
            "hash": fingerprint_hash(new_fp),
            "updated_at": ts if changes else old_entry.get("updated_at", ts),
        }

    append_events(events)
    atomic_write_json(STATE_FILE, new_state)
    log("pass: %d tickers tracked, %d state changes (scan updated_at=%s)"
        % (len(new_state), len(events), scan.get("updated_at")))

    # ---- reads: any ticker present in the current scan whose read is stale.
    reads = load_json(READS_FILE, {})
    if not isinstance(reads, dict):
        reads = {}

    candidates = []
    for sym in current_fp:
        h = new_state.get(sym, {}).get("hash")
        if h and reads.get(sym, {}).get("state_hash") != h:
            candidates.append(sym)
    # Tickers whose state changed THIS pass are live signals — they jump the
    # queue; the stale backlog fills whatever capacity remains, by mcap.
    changed_now = {e["ticker"] for e in events}
    candidates.sort(key=lambda s: (s not in changed_now,
                                   -(meta.get(s, {}).get("mcap") or 0)))
    queue = candidates[:MAX_READS_PER_PASS]
    if len(candidates) > len(queue):
        log("read backlog: %d tickers stale (%d changed this pass), generating %d this pass"
            % (len(candidates), len(changed_now), len(queue)))

    if queue and client is None:
        log("LLM client unavailable -- skipping %d reads (state and events "
            "still updated; reads retry next pass)" % len(queue))
        return

    generated, failures = 0, 0
    last_error = None
    for sym in queue:
        try:
            text = generate_read(client, sym, facts.get(sym, {}),
                                 meta.get(sym, {}))
            if not text:
                raise ValueError("empty completion")
            reads[sym] = {"read": text, "updated_at": now_iso(),
                          "state_hash": new_state[sym]["hash"]}
            generated += 1
            failures = 0
        except Exception as exc:  # LLM down/misconfigured must never kill the loop
            failures += 1
            last_error = "%s: %s: %s" % (sym, type(exc).__name__, str(exc)[:300])
            log("read failed for %s: %s" % (sym, exc))
            if failures >= LLM_FAIL_LIMIT:
                log("%d consecutive LLM failures -- abandoning reads for this pass"
                    % failures)
                break

    if generated:
        atomic_write_json(READS_FILE, reads)
    log("reads: %d generated (%d queued, %d already fresh)"
        % (generated, len(queue), len(current_fp) - len(candidates)))
    # Pass telemetry, published alongside reads.json — headless environments
    # (GitHub Actions) have no readable logs, so failures must surface here.
    atomic_write_json(OUT_DIR / "status.json", {
        "ts": now_iso(), "model": LLM_MODEL, "base_url": LLM_BASE_URL,
        "events": len(events), "queued": len(queue),
        "generated": generated, "last_error": last_error,
    })


# --------------------------------------------------------------------------- main


def main(argv=None):
    ap = argparse.ArgumentParser(description="IQ Algo reads worker")
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="run a single pass")
    mode.add_argument("--loop", action="store_true", help="run forever")
    ap.add_argument("--interval", type=int, default=300,
                    help="seconds between passes in --loop mode (default 300)")
    args = ap.parse_args(argv)

    log("reads worker starting: scan=%s llm=%s model=%s"
        % (SCAN_BASE, LLM_BASE_URL, LLM_MODEL))
    client = make_client()

    if args.once:
        run_pass(client)
        return 0

    while True:
        started = time.monotonic()
        try:
            run_pass(client)
        except Exception as exc:  # belt and braces: the loop must survive anything
            log("pass crashed: %s: %s" % (type(exc).__name__, exc))
        elapsed = time.monotonic() - started
        time.sleep(max(1.0, args.interval - elapsed))


if __name__ == "__main__":
    sys.exit(main())
