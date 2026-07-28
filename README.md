# iq-data

AI-generated ticker reads for the IQ Algo / trend-iq site.

- `ai/worker/` — the reads worker: diffs engine state from the public THT scan
  feed, generates short reads via an OpenAI-compatible LLM endpoint, logs every
  state change (powers "What's changed?").
- `ai/prompts/` — prompt pack + vocabulary glossary.
- `docs/ai/reads.json` — the published feed (GitHub Pages), consumed by the site.
- `docs/ai/status.json` — per-pass telemetry (generated count, last error).

Scan data is consumed read-only from the public Pages JSON of the THT scan
pipeline. This repo never writes anywhere else.

Config is env-driven: `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `SCAN_BASE`,
`MAX_READS_PER_PASS`. Local dev runs against Ollama (see `ai/worker/README.md`).
