# iq-data

The IQ Algo scan + AI reads pipeline for the trend-iq site. A GitHub Actions
cron runs the scanner, then the reads worker, and publishes everything as
static JSON on GitHub Pages (`https://piraci26.github.io/iq-data`).

## Layout

- `scanner.py` — nightly universe scanner. Pulls the ticker universe +
  market caps read-only from the public tht-data Pages feed, fetches daily
  OHLCV per ticker from the Yahoo v8 chart API (confirmed bars only — the
  still-open session bar is dropped), resamples weekly (ISO week) and
  monthly (calendar month) bars in code, runs the three engines, and writes
  `docs/iq/scan.json` + `docs/iq/events.json` atomically. A MIN_OK guard
  keeps the previous output when a run loses too many tickers. Pure stdlib
  (bars fetched via a `curl` subprocess with urllib fallback).
- `engines/` — bar-for-bar Python ports of the three Pine indicators, pure
  stdlib, each with a built-in self-test (`python3 engines/<name>.py`):
  - `bands.py` — IQ Bands (trend regime): sticky bull/bear regime with
    2-bar confirm, flip events + volume grade, fib target ladder,
    chandelier trail, exhaustion, noise/HV gauges, overlay pack.
  - `oscillator.py` — IQ Oscillator (momentum): RSI-of-EMA-diff wave +
    signal, money flow, adaptive stretched zones, turns/reversals,
    divergences, dual-confirmation confluence.
  - `structure.py` — IQ Structure (price action): dual-tier
    (internal/major) BOS / CHoCH / CHoCH+, EQH/EQL liquidity + sweeps,
    trendline breaks. Order blocks and FVGs are not ported in v1.
  - `ta.py` — shared Pine `ta.*` helpers (Pine v6 na semantics).
- `ai/worker/` — the reads worker: fingerprints each ticker's engine state
  from `iq/scan.json`, diffs against the last pass, logs every change to
  `state/events.jsonl`, and generates 2-3 sentence per-ticker "reads" via
  an OpenAI-compatible LLM. `whats_changed.py` answers "what changed for
  TICKER since T?" from the same log. See `ai/worker/README.md`.
- `ai/prompts/` — prompt pack + vocabulary glossary.
- `.github/workflows/reads.yml` — the cron: scan (top 500 by mcap) →
  reads → commit `docs/`.

## Published feed (GitHub Pages, `docs/`)

- `iq/scan.json` — full engine state per ticker:
  `{updated_at, universe_size, scanned, skipped, bar_range, tickers: {SYM:
  {name, mcap, price, bars_daily, d: {bands, osc, structure}, w: {bands,
  osc}, m: {bands, osc}}}}` (weekly/monthly run bands + oscillator only).
- `iq/events.json` — every event fired on the last confirmed bar:
  `{updated_at, count, events: [{sym, tf, engine, event, side}]}`.
- `ai/reads.json` — `{ticker: {read, updated_at, state_hash}}`.
- `ai/status.json` — per-pass worker telemetry (generated count, last error).

## Config (env)

Scanner: `UNIVERSE_TOP` (500), `MIN_OK` (100), `BAR_RANGE` (2y — use 10y if
monthly bands/oscillator need full warm-up), `YAHOO_DELAY` (0.15).
Worker: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_TIMEOUT`,
`SCAN_BASE` (URL or local dir; CI uses `docs`), `MAX_READS_PER_PASS`,
`FETCH_TIMEOUT`.

Local dev runs the worker against Ollama with no env at all
(`llama3.1:8b` at `http://localhost:11434/v1`).

Scan inputs are consumed read-only from the public tht-data Pages JSON; this
repo never writes anywhere but its own `docs/` and worker state.
