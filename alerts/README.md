# Alerts

`alert_worker.py` sends the alerts Alpha Charts advertises. After every scan
pass it reads the feeds the pass published and sends each **new** alert once
to every subscription that watches it, by email (Resend), webhook (JSON,
Discord or Slack) or Telegram.

## What it watches

| Source | What fires |
|---|---|
| `docs/iq/events.json` | every IQ Bands, IQ Oscillator and IQ Structure event on each ticker's last confirmed daily, weekly and monthly bar |
| `docs/iq/signals.json` | Short Term Alerts: the minute engine's 30m, 2h and daily regimes locking the same side (`completed_at`) |
| `docs/iq/scan.json` | name, price and market cap for the message and the `min_mcap_b` filter |

An alert goes out when an event appears that was not on the board last pass,
and was not already sent to that subscription and channel within the
timeframe's window (daily 20h, weekly 6d, monthly 27d). A ticker the scan
skipped keeps its previous events, so it does not re-alert when it returns.
**The first run records the board and sends nothing.**

## Subscriptions

The `ALERTS_CONFIG` repository secret holds JSON shaped like
[`config.example.json`](config.example.json). Per subscription:

- `watch.symbols`: `"*"` or a list; `watch.exclude`: a list
- `watch.timeframes`: any of `d`, `w`, `m` (Short Term Alerts ignore it)
- `watch.min_mcap_b`: minimum market cap in billions
- `watch.sides`: `long`, `short`
- `watch.events`: presets or raw `engine.event` names
  - `signals`: IQ Bands buy / sell (the Signals page flip)
  - `strong`, `targets` (target hits and exits), `momentum` (oscillator flips and dual confirmations), `divergence`, `structure` (major BOS / CHoCH), `short_term` (the minute triples), `all`
  - default: `["signals", "short_term"]`
- channels: `email` (list), `webhooks` (`url`, optional `secret`, `format`: `json` | `discord` | `slack`), `telegram` (`chat_id`)
- `max_per_pass`: cap per message (default 30; the rest are counted, not dropped silently)

## Secrets and variables

| Name | Kind | Needed for |
|---|---|---|
| `ALERTS_CONFIG` | secret | the subscriptions |
| `RESEND_API_KEY` | secret | email |
| `TELEGRAM_BOT_TOKEN` | secret | Telegram |
| `ALERTS_FROM` | variable | sender, e.g. `Alpha Charts <alerts@alphacharts.us>`; until a domain is verified in Resend, `onboarding@resend.dev` only delivers to the Resend account's own address |
| `ALERTS_SITE` | variable | link base (default `https://trend-iq.lovable.app`) |

## Webhook payload

One POST per alert:

```json
{"source":"alpha-charts","type":"alert","version":1,"id":"3f1c…","sent_at":"2026-09-17T21:30:00+00:00",
 "symbol":"NVDA","name":"NVIDIA Corporation","timeframe":"1D","engine":"IQ Bands","event":"sig_buy",
 "label":"buy signal","side":"long","price":213.9,"fired_at":"2026-09-17T21:11:04+00:00",
 "text":"NVDA · IQ Bands buy signal · 1D · $213.90","url":"https://trend-iq.lovable.app/screener?sel=NVDA"}
```

With a `secret`, each request carries `X-Alpha-Charts-Timestamp` and
`X-Alpha-Charts-Signature: sha256=HMAC_SHA256(secret, timestamp + "." + body)`.

## Run it

```bash
python alerts/alert_worker.py --self-test                                   # offline tests
python alerts/alert_worker.py --docs docs --config alerts/config.example.json --dry-run --treat-all-new --state /tmp/alerts
python alerts/alert_worker.py --docs docs                                   # a real pass (uses ALERTS_CONFIG)
```

`.github/workflows/alerts.yml` runs it after every successful
"IQ Scan + AI Reads" run, and on demand from the Actions tab.
