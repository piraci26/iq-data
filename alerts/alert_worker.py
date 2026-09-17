#!/usr/bin/env python3
"""Alpha Charts alert worker.

Sends the alerts the site promises: when an engine fires on a confirmed bar
(an IQ Bands buy or sell, a momentum flip, a major structure break) or the
minute engine locks 30m, 2h and daily the same way (a Short Term Alert), every
subscription that watches it gets one message, by email, webhook or Telegram.

It runs after each scan pass (.github/workflows/alerts.yml) and reads only the
feeds the scan already publishes:
  iq/events.json   every event fired on each ticker's last confirmed bar
  iq/scan.json     name, price and market cap per ticker
  iq/signals.json  the minute engine's triples (completed_at = when all three
                   timeframes locked the same side)

The scan republishes the same last-bar events every pass until the next bar
confirms, so an alert goes out when an event APPEARS (it was not in the last
pass) and was not already sent to that subscription and channel inside the
timeframe's window. A ticker the scan skipped keeps its previous events, so
it does not look new when it comes back. The first run with no state records
what is already on the board and sends nothing.

Subscriptions come from ALERTS_CONFIG (JSON, a repository secret) or
--config; see alerts/config.example.json. Nothing personal is committed or
printed: state lives in the Actions cache and logs name subscriptions by id.

Secrets / env:
  ALERTS_CONFIG       the subscriptions JSON (or --config path)
  RESEND_API_KEY      email through Resend
  ALERTS_FROM         sender, e.g. "Alpha Charts <alerts@getalphacharts.com>"
                      (Resend's onboarding@resend.dev only delivers to the
                      Resend account's own address until a domain is verified)
  TELEGRAM_BOT_TOKEN  Telegram delivery
  ALERTS_SITE         link base, default https://getalphacharts.com

Usage:
  python alerts/alert_worker.py --docs docs              # a real pass
  python alerts/alert_worker.py --docs docs --dry-run    # print, send nothing
  python alerts/alert_worker.py --self-test              # offline test suite
Pure stdlib.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_STATE = HERE / "state"
DEFAULT_SITE = "https://getalphacharts.com"
DEFAULT_FROM = "Alpha Charts <onboarding@resend.dev>"
FETCH_TIMEOUT = 30
SEND_TIMEOUT = 12
MAX_PER_SUB = 30
STATE_VERSION = 1

ENGINE_NAME = {"bands": "IQ Bands", "osc": "IQ Oscillator", "structure": "IQ Structure", "minute": "Short Term Alert"}
TF_NAME = {"d": "1D", "w": "1W", "m": "1M", "st": "30m · 2h · 1D"}
# an event already sent is not sent again inside this window, even if it
# disappears for a pass and comes back (a flaky fetch, a skipped ticker)
RESEND_WINDOW = {"d": timedelta(hours=20), "w": timedelta(days=6), "m": timedelta(days=27), "st": timedelta(hours=20)}

LABEL = {
    "bands": {
        "sig_buy": "buy signal", "sig_sell": "sell signal", "strong": "strong flip",
        "rearm_up": "re-armed long", "rearm_dn": "re-armed short",
        "hit1": "target 1 hit", "hit2": "target 2 hit", "hit3": "target 3 hit",
        "exit_long": "long exit", "exit_short": "short exit",
        "exhaust_up": "upside exhaustion", "exhaust_dn": "downside exhaustion",
        "st_fast_flip_up": "fast trend turned up", "st_fast_flip_dn": "fast trend turned down",
        "st_slow_flip_up": "slow trend turned up", "st_slow_flip_dn": "slow trend turned down",
        "macro_flip": "macro regime flip", "zone_enter_up": "entered the upper zone", "zone_enter_dn": "entered the lower zone",
    },
    "osc": {
        "flip_up": "momentum flipped up", "flip_dn": "momentum flipped down",
        "turn_up": "wave turned up", "turn_dn": "wave turned down",
        "turn_up_ungated": "early wave turn up", "turn_dn_ungated": "early wave turn down",
        "rev_up": "reversal up", "rev_dn": "reversal down",
        "dual_long": "dual confirmation long", "dual_short": "dual confirmation short",
        "bull_div": "bullish divergence", "bear_div": "bearish divergence",
        "h_bull_div": "hidden bullish divergence", "h_bear_div": "hidden bearish divergence",
        "enter_hi": "entered overbought", "enter_lo": "entered oversold",
    },
    "structure": {
        "bos_up": "break of structure up", "bos_dn": "break of structure down",
        "choch_up": "change of character up", "choch_dn": "change of character down",
        "choch_up_plus": "confirmed change of character up", "choch_dn_plus": "confirmed change of character down",
        "maj_bos_up": "major break of structure up", "maj_bos_dn": "major break of structure down",
        "maj_choch_up": "major change of character up", "maj_choch_dn": "major change of character down",
        "maj_choch_up_plus": "confirmed major change of character up", "maj_choch_dn_plus": "confirmed major change of character down",
        "tl_break_up": "trendline break up", "tl_break_dn": "trendline break down",
        "sweep_hi": "sweep above the highs", "sweep_lo": "sweep below the lows",
    },
}

PRESETS = {
    "signals": ["bands.sig_buy", "bands.sig_sell"],
    "strong": ["bands.strong"],
    "targets": ["bands.hit1", "bands.hit2", "bands.hit3", "bands.exit_long", "bands.exit_short"],
    "momentum": ["osc.flip_up", "osc.flip_dn", "osc.dual_long", "osc.dual_short"],
    "divergence": ["osc.bull_div", "osc.bear_div"],
    "structure": ["structure.maj_bos_up", "structure.maj_bos_dn", "structure.maj_choch_up", "structure.maj_choch_dn",
                  "structure.maj_choch_up_plus", "structure.maj_choch_dn_plus"],
    "short_term": ["minute.triple"],
}
DEFAULT_EVENTS = ["signals", "short_term"]


def log(msg: str) -> None:
    print(f"[alerts] {msg}", flush=True)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


# ---------------------------------------------------------------- feeds

def load_feed(base: str, rel: str) -> dict:
    """iq/<file> from a local docs dir or the published Pages URL."""
    if base.startswith("http://") or base.startswith("https://"):
        url = base.rstrip("/") + "/" + rel
        req = urllib.request.Request(url, headers={"User-Agent": "alpha-charts-alerts/1"})
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as fh:
            return json.loads(fh.read().decode("utf-8"))
    return json.loads((Path(base) / rel).read_text(encoding="utf-8"))


def collect_alerts(events: dict, scan: dict, signals: dict | None) -> tuple[list[dict], set[str]]:
    """Every alertable fact on the board right now, and the tickers the scan skipped."""
    tickers = scan.get("tickers") or {}
    skipped = set(scan.get("skipped") or [])
    out: list[dict] = []
    seen: set[str] = set()
    for ev in events.get("events") or []:
        sym, tf, eng, name = ev.get("sym"), ev.get("tf"), ev.get("engine"), ev.get("event")
        if not (sym and tf in TF_NAME and eng in LABEL and name):
            continue
        key = f"{sym}|{tf}|{eng}|{name}"
        if key in seen:
            continue
        seen.add(key)
        t = tickers.get(sym) or {}
        out.append({
            "key": key, "sym": sym, "name": t.get("name") or sym, "tf": tf, "engine": eng, "event": name,
            "side": ev.get("side"), "label": LABEL[eng].get(name, name.replace("_", " ")),
            "price": t.get("price"), "mcap_b": t.get("mcap"), "at": events.get("updated_at"),
        })
    for tr in (signals or {}).get("triples") or []:
        done = tr.get("completed_at")
        sym, side = tr.get("sym"), tr.get("side")
        if not (done and sym and side in ("bull", "bear")):
            continue
        key = f"{sym}|st|minute|triple_{side}|{done}"
        if key in seen:
            continue
        seen.add(key)
        t = tickers.get(sym) or {}
        word = "bullish" if side == "bull" else "bearish"
        out.append({
            "key": key, "sym": sym, "name": tr.get("name") or t.get("name") or sym, "tf": "st", "engine": "minute",
            "event": "triple", "side": "long" if side == "bull" else "short",
            "label": f"30m, 2h and daily all {word}", "price": tr.get("price", t.get("price")),
            "mcap_b": t.get("mcap"), "at": done,
        })
    return out, skipped


# ---------------------------------------------------------------- config

def load_config(path: str | None) -> dict:
    raw = None
    if path:
        raw = Path(path).read_text(encoding="utf-8")
    elif os.environ.get("ALERTS_CONFIG", "").strip():
        raw = os.environ["ALERTS_CONFIG"]
    elif (HERE / "config.json").exists():
        raw = (HERE / "config.json").read_text(encoding="utf-8")
    if raw is None:
        return {"subscriptions": []}
    cfg = json.loads(raw)
    if not isinstance(cfg.get("subscriptions"), list):
        raise ValueError("config needs a subscriptions list")
    for i, sub in enumerate(cfg["subscriptions"]):
        sub.setdefault("id", f"sub{i + 1}")
    return cfg


def expand_events(names: list[str] | None) -> set[str]:
    wanted: set[str] = set()
    for n in names or DEFAULT_EVENTS:
        if n == "all":
            wanted.add("*")
        elif n in PRESETS:
            wanted.update(PRESETS[n])
        else:
            wanted.add(n)
    return wanted


def matches(sub: dict, a: dict) -> bool:
    w = sub.get("watch") or {}
    syms = w.get("symbols", "*")
    if syms != "*" and a["sym"] not in {s.upper() for s in syms}:
        return False
    if a["sym"] in {s.upper() for s in w.get("exclude") or []}:
        return False
    tfs = w.get("timeframes")
    if tfs and a["tf"] != "st" and a["tf"] not in tfs:
        return False
    min_b = w.get("min_mcap_b")
    if min_b is not None and (a.get("mcap_b") is None or a["mcap_b"] < float(min_b)):
        return False
    sides = w.get("sides")
    if sides and a.get("side") not in sides:
        return False
    wanted = expand_events(w.get("events"))
    return "*" in wanted or f"{a['engine']}.{a['event']}" in wanted


# ---------------------------------------------------------------- state

def load_state(state_dir: Path) -> dict | None:
    p = state_dir / "state.json"
    if not p.exists():
        return None
    try:
        st = json.loads(p.read_text(encoding="utf-8"))
        return st if st.get("version") == STATE_VERSION else None
    except (OSError, ValueError):
        return None


def save_state(state_dir: Path, st: dict) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    tmp = state_dir / "state.json.tmp"
    tmp.write_text(json.dumps(st, separators=(",", ":")), encoding="utf-8")
    os.replace(tmp, state_dir / "state.json")


def sent_key(sub_id: str, channel: str, key: str) -> str:
    # hashed so the cache holds no symbols-per-person map in the clear
    return hashlib.sha256(f"{sub_id}|{channel}|{key}".encode()).hexdigest()[:32]


def prune_sent(sent: dict, now: datetime) -> dict:
    keep_after = now - timedelta(days=30)
    return {k: v for k, v in sent.items() if (parse_iso(v) or now) > keep_after}


# ---------------------------------------------------------------- delivery

class Transport:
    """HTTP POST with a short retry on network errors and 5xx; tests swap it out."""

    def post(self, url: str, body: bytes, headers: dict) -> tuple[int, str]:
        last = (0, "")
        for attempt in range(3):
            req = urllib.request.Request(url, data=body, method="POST", headers={"User-Agent": "alpha-charts-alerts/1", **headers})
            try:
                with urllib.request.urlopen(req, timeout=SEND_TIMEOUT) as fh:
                    return fh.status, fh.read(2000).decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                last = (e.code, e.read(500).decode("utf-8", "replace"))
                if e.code < 500 and e.code != 429:
                    return last
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                last = (0, str(e))
            time.sleep(1 + attempt * 2)
        return last


def price_text(a: dict) -> str:
    p = a.get("price")
    return f"${p:,.2f}" if isinstance(p, (int, float)) else ""


def alert_line(a: dict) -> str:
    parts = [a["sym"], ENGINE_NAME[a["engine"]] + " " + a["label"] if a["engine"] != "minute" else f"Short Term Alert: {a['label']}",
             TF_NAME[a["tf"]] if a["engine"] != "minute" else "", price_text(a)]
    return " · ".join(p for p in parts if p)


def alert_url(site: str, a: dict) -> str:
    return f"{site.rstrip('/')}/screener?sel={a['sym']}"


def payload_of(a: dict, site: str, sent_at: str) -> dict:
    return {
        "source": "alpha-charts", "type": "alert", "version": 1,
        "id": hashlib.sha1(a["key"].encode()).hexdigest()[:16],
        "sent_at": sent_at, "symbol": a["sym"], "name": a["name"],
        "timeframe": TF_NAME[a["tf"]], "engine": ENGINE_NAME[a["engine"]], "event": a["event"],
        "label": a["label"], "side": a.get("side"), "price": a.get("price"),
        "fired_at": a.get("at"), "text": alert_line(a), "url": alert_url(site, a),
    }


def send_webhook(tp: Transport, hook: dict, alerts: list[dict], site: str, sent_at: str) -> tuple[bool, str]:
    fmt = (hook.get("format") or "json").lower()
    ok_all = True
    detail = ""
    for a in alerts:
        if fmt == "discord":
            body = {"content": f"**{a['sym']}** · {alert_line(a).split(' · ', 1)[1]}\n{alert_url(site, a)}"}
        elif fmt == "slack":
            body = {"text": f"*{a['sym']}* · {alert_line(a).split(' · ', 1)[1]}\n{alert_url(site, a)}"}
        else:
            body = payload_of(a, site, sent_at)
        raw = json.dumps(body, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json"}
        secret = hook.get("secret")
        if secret and fmt == "json":
            ts = str(int(time.time()))
            sig = hmac.new(secret.encode(), ts.encode() + b"." + raw, hashlib.sha256).hexdigest()
            headers["X-Alpha-Charts-Timestamp"] = ts
            headers["X-Alpha-Charts-Signature"] = f"sha256={sig}"
        code, text = tp.post(hook["url"], raw, headers)
        if not 200 <= code < 300:
            ok_all = False
            detail = f"HTTP {code} {text[:120]}"
            break
    return ok_all, detail


def email_bodies(alerts: list[dict], extra: int, site: str, sub_id: str) -> tuple[str, str, str]:
    if len(alerts) == 1:
        a = alerts[0]
        subject = f"{a['sym']} · {ENGINE_NAME[a['engine']]} {a['label']}" + (f" ({TF_NAME[a['tf']]})" if a["engine"] != "minute" else "")
    else:
        syms = []
        for a in alerts:
            if a["sym"] not in syms:
                syms.append(a["sym"])
        more = f" +{len(syms) - 3}" if len(syms) > 3 else ""
        subject = f"{len(alerts) + extra} alerts · {', '.join(syms[:3])}{more}"
    lines = [f"{alert_line(a)}\n{alert_url(site, a)}" for a in alerts]
    if extra:
        lines.append(f"…and {extra} more on the Signals page.")
    foot = "You get these because your Alpha Charts alerts watch these signals. Signals describe a chart; they are not advice to trade."
    text = "\n\n".join(lines) + "\n\n" + foot
    rows = "".join(
        f'<tr><td style="padding:10px 0;border-bottom:1px solid #e6e6e6">'
        f'<div style="font-size:15px;font-weight:600;color:#111">{esc(a["sym"])} <span style="font-weight:400;color:#555">{esc(a["name"])}</span></div>'
        f'<div style="font-size:14px;color:#111;margin-top:2px">{esc(alert_line(a).split(" · ", 1)[1] if " · " in alert_line(a) else alert_line(a))}</div>'
        f'<div style="margin-top:4px"><a href="{esc(alert_url(site, a))}" style="font-size:13px;color:#2563eb">Open in Alpha Charts</a></div></td></tr>'
        for a in alerts
    )
    more_row = f'<tr><td style="padding:10px 0;font-size:13px;color:#555">…and {extra} more on the Signals page.</td></tr>' if extra else ""
    html = (
        '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;margin:0 auto;padding:16px">'
        '<div style="font-size:13px;color:#555;margin-bottom:6px">Alpha Charts alerts</div>'
        f'<table style="width:100%;border-collapse:collapse">{rows}{more_row}</table>'
        f'<p style="font-size:12px;color:#777;margin-top:16px">{esc(foot)}</p></div>'
    )
    return f"Alpha Charts · {subject}", text, html


def esc(s: str) -> str:
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))


def send_email(tp: Transport, to: list[str], alerts: list[dict], extra: int, site: str, sub_id: str) -> tuple[bool, str]:
    key = os.environ.get("RESEND_API_KEY", "").strip()
    if not key:
        return False, "RESEND_API_KEY not set"
    subject, text, html = email_bodies(alerts, extra, site, sub_id)
    body = {"from": os.environ.get("ALERTS_FROM", "").strip() or DEFAULT_FROM, "to": to, "subject": subject, "text": text, "html": html}
    code, resp = tp.post("https://api.resend.com/emails", json.dumps(body).encode(), {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    return (200 <= code < 300), ("" if 200 <= code < 300 else f"HTTP {code} {resp[:160]}")


def send_telegram(tp: Transport, chat: dict, alerts: list[dict], extra: int, site: str) -> tuple[bool, str]:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        return False, "TELEGRAM_BOT_TOKEN not set"
    text = "\n\n".join(f"{alert_line(a)}\n{alert_url(site, a)}" for a in alerts)
    if extra:
        text += f"\n\n…and {extra} more."
    body = {"chat_id": chat["chat_id"], "text": text[:4000], "disable_web_page_preview": True}
    code, resp = tp.post(f"https://api.telegram.org/bot{token}/sendMessage", json.dumps(body).encode(), {"Content-Type": "application/json"})
    return (200 <= code < 300), ("" if 200 <= code < 300 else f"HTTP {code} {resp[:160]}")


# ---------------------------------------------------------------- one pass

def run_pass(docs: str, cfg: dict, state_dir: Path, *, dry_run: bool = False, tp: Transport | None = None,
             now: datetime | None = None, treat_all_new: bool = False) -> dict:
    tp = tp or Transport()
    now = now or now_utc()
    site = os.environ.get("ALERTS_SITE", "").strip() or cfg.get("site") or DEFAULT_SITE
    events = load_feed(docs, "iq/events.json")
    scan = load_feed(docs, "iq/scan.json")
    try:
        signals = load_feed(docs, "iq/signals.json")
    except (OSError, ValueError, urllib.error.URLError):
        signals = None
    board, skipped = collect_alerts(events, scan, signals)
    board_keys = {a["key"] for a in board}
    st = load_state(state_dir)
    summary = {"board": len(board), "new": 0, "sent": 0, "failed": 0, "seeded": False, "subs": len(cfg.get("subscriptions") or [])}

    if st is None and not treat_all_new:
        # first run: remember what is already on the board, send nothing
        if not dry_run:
            save_state(state_dir, {"version": STATE_VERSION, "prev": sorted(board_keys), "sent": {}, "seeded_at": iso(now)})
        summary["seeded"] = True
        log(f"seeded with {len(board_keys)} facts already on the board; nothing sent")
        return summary

    st = st or {"version": STATE_VERSION, "prev": [], "sent": {}}
    prev = set(st.get("prev") or [])
    fresh = [a for a in board if treat_all_new or a["key"] not in prev]
    summary["new"] = len(fresh)
    sent = prune_sent(st.get("sent") or {}, now)
    stamp = iso(now)

    for sub in cfg.get("subscriptions") or []:
        mine = [a for a in fresh if matches(sub, a)]
        if not mine:
            continue
        mine.sort(key=lambda a: (-(a.get("mcap_b") or 0), a["sym"]))
        cap = int(sub.get("max_per_pass") or MAX_PER_SUB)
        channels: list[tuple[str, dict]] = []
        if sub.get("email"):
            channels.append(("email", {"to": list(sub["email"])}))
        for i, hook in enumerate(sub.get("webhooks") or []):
            channels.append((f"webhook{i}", hook))
        for i, chat in enumerate(sub.get("telegram") or []):
            channels.append((f"telegram{i}", chat))
        for ch_name, ch in channels:
            due = []
            for a in mine:
                k = sent_key(sub["id"], ch_name, a["key"])
                last = parse_iso(sent.get(k))
                if last and now - last < RESEND_WINDOW[a["tf"]]:
                    continue
                due.append((k, a))
            if not due:
                continue
            batch, extra = due[:cap], max(0, len(due) - cap)
            alerts = [a for _, a in batch]
            if dry_run:
                log(f"would send {len(alerts)}{f' (+{extra})' if extra else ''} to {sub['id']} via {ch_name}: " + "; ".join(alert_line(a) for a in alerts[:5]) + (" …" if len(alerts) > 5 else ""))
                continue
            if ch_name == "email":
                ok, detail = send_email(tp, ch["to"], alerts, extra, site, sub["id"])
            elif ch_name.startswith("webhook"):
                ok, detail = send_webhook(tp, ch, alerts, site, stamp)
            else:
                ok, detail = send_telegram(tp, ch, alerts, extra, site)
            if ok:
                for k, _ in due:  # the overflow counts as told: it was named in the message
                    sent[k] = stamp
                summary["sent"] += len(alerts)
                log(f"sent {len(alerts)} to {sub['id']} via {ch_name}")
            else:
                summary["failed"] += len(alerts)
                log(f"FAILED {len(alerts)} to {sub['id']} via {ch_name}: {detail}")
            if ch_name == "email":
                time.sleep(0.6)  # Resend allows two requests a second

    # a skipped ticker keeps last pass's facts, so it does not read as new when it returns
    carried = {k for k in prev if k.split("|", 1)[0] in skipped}
    if not dry_run:
        save_state(state_dir, {"version": STATE_VERSION, "prev": sorted(board_keys | carried), "sent": sent, "updated_at": stamp})
    log(f"board {summary['board']} · new {summary['new']} · sent {summary['sent']} · failed {summary['failed']} · subscriptions {summary['subs']}")
    return summary


# ---------------------------------------------------------------- self-test

def self_test() -> int:
    import http.server
    import threading

    received: list[tuple[dict, dict, bytes]] = []

    class Hook(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            raw = self.rfile.read(int(self.headers.get("Content-Length") or 0))
            received.append((dict(self.headers), json.loads(raw), raw))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")

        def log_message(self, *args):
            pass

    srv = http.server.HTTPServer(("127.0.0.1", 0), Hook)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    hook_url = f"http://127.0.0.1:{srv.server_address[1]}/hook"

    class Recorder(Transport):
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []

        def post(self, url, body, headers):
            if url.startswith("http://127.0.0.1"):
                return Transport.post(self, url, body, headers)
            self.calls.append((url, json.loads(body)))
            return 200, "{}"

    def write_docs(root: Path, events: list[dict], triples: list[dict], skipped: list[str] | None = None, at: str = "2026-09-17T21:00:00+00:00"):
        (root / "iq").mkdir(parents=True, exist_ok=True)
        (root / "iq/events.json").write_text(json.dumps({"updated_at": at, "count": len(events), "events": events}))
        tickers = {s: {"name": f"{s} Inc.", "price": 100.0, "mcap": m} for s, m in [("NVDA", 5000.0), ("AAPL", 4800.0), ("TINY", 0.5)]}
        (root / "iq/scan.json").write_text(json.dumps({"updated_at": at, "skipped": skipped or [], "tickers": tickers}))
        (root / "iq/signals.json").write_text(json.dumps({"updated_at": at, "triples": triples}))

    failures = []

    def check(cond, what):
        if not cond:
            failures.append(what)

    os.environ["RESEND_API_KEY"] = "test-key"
    os.environ["TELEGRAM_BOT_TOKEN"] = "123:test"
    os.environ.pop("ALERTS_FROM", None)
    cfg = {"site": "https://example.test", "subscriptions": [
        {"id": "all-signals", "watch": {"symbols": "*", "min_mcap_b": 10, "events": ["signals", "short_term"]},
         "email": ["someone@example.test"], "webhooks": [{"url": hook_url, "secret": "s3cret"}], "telegram": [{"chat_id": "42"}]},
        {"id": "nvda-momentum", "watch": {"symbols": ["NVDA"], "timeframes": ["d"], "events": ["momentum"]}, "webhooks": [{"url": hook_url, "format": "discord"}]},
    ]}
    t0 = datetime(2026, 9, 17, 21, 0, tzinfo=timezone.utc)
    with tempfile.TemporaryDirectory() as tmp:
        root, state = Path(tmp) / "docs", Path(tmp) / "state"
        base_events = [{"sym": "NVDA", "tf": "d", "engine": "bands", "event": "exhaust_up", "side": "long"}]
        write_docs(root, base_events, [])
        s1 = run_pass(str(root), cfg, state, tp=Recorder(), now=t0)
        check(s1["seeded"] and s1["sent"] == 0 and not received, "first run seeds and sends nothing")

        ev2 = base_events + [
            {"sym": "NVDA", "tf": "d", "engine": "bands", "event": "sig_buy", "side": "long"},
            {"sym": "AAPL", "tf": "w", "engine": "bands", "event": "sig_sell", "side": "short"},
            {"sym": "TINY", "tf": "d", "engine": "bands", "event": "sig_buy", "side": "long"},
            {"sym": "NVDA", "tf": "d", "engine": "osc", "event": "flip_up", "side": "long"},
        ]
        tri = [{"sym": "AAPL", "name": "Apple Inc.", "side": "bull", "price": 231.5, "completed_at": "2026-09-17T20:30:00+00:00"}]
        write_docs(root, ev2, tri)
        rec = Recorder()
        s2 = run_pass(str(root), cfg, state, tp=rec, now=t0 + timedelta(minutes=30))
        emails = [b for u, b in rec.calls if "resend" in u]
        tgs = [b for u, b in rec.calls if "telegram" in u]
        json_hooks = [r for r in received if "source" in r[1]]
        discord = [r for r in received if "content" in r[1]]
        check(len(emails) == 1 and len(emails[0]["to"]) == 1, "one digest email per subscription")
        check(emails and "3 alerts" in emails[0]["subject"], f"email subject counts the alerts: {emails[0]['subject'] if emails else None}")
        check(len(tgs) == 1 and tgs[0]["chat_id"] == "42", "one telegram message")
        check(len(json_hooks) == 3, f"json webhook gets one request per alert (got {len(json_hooks)})")
        check(all(r[1]["symbol"] != "TINY" for r in json_hooks), "min_mcap_b filters small names")
        check(len(discord) == 1 and "NVDA" in discord[0][1]["content"], "discord format for the momentum watcher")
        for headers, body, raw in json_hooks:
            low = {k.lower(): v for k, v in headers.items()}  # HTTP header names are case-insensitive
            ts = low.get("x-alpha-charts-timestamp")
            sig = low.get("x-alpha-charts-signature")
            want = "sha256=" + hmac.new(b"s3cret", (ts or "").encode() + b"." + raw, hashlib.sha256).hexdigest()
            check(sig == want, "webhook signature verifies")
        check(any(r[1]["event"] == "triple" and r[1]["symbol"] == "AAPL" for r in json_hooks), "short term alert delivered")
        check(s2["sent"] >= 3 and s2["failed"] == 0, f"pass 2 summary {s2}")

        n_before = len(received)
        rec3 = Recorder()
        s3 = run_pass(str(root), cfg, state, tp=rec3, now=t0 + timedelta(minutes=60))
        check(s3["sent"] == 0 and not rec3.calls and len(received) == n_before, "an unchanged board sends nothing")

        # NVDA skipped for a pass, then back: no repeat
        write_docs(root, [e for e in ev2 if e["sym"] != "NVDA"], tri, skipped=["NVDA"])
        run_pass(str(root), cfg, state, tp=Recorder(), now=t0 + timedelta(minutes=90))
        write_docs(root, ev2, tri)
        rec5 = Recorder()
        s5 = run_pass(str(root), cfg, state, tp=rec5, now=t0 + timedelta(minutes=120))
        check(s5["sent"] == 0 and not rec5.calls and len(received) == n_before, "a skipped ticker coming back is not re-sent")

        # the next day the same flip fires again on a new bar: it goes out again
        write_docs(root, base_events, [])
        run_pass(str(root), cfg, state, tp=Recorder(), now=t0 + timedelta(hours=20))
        write_docs(root, ev2[:2], [])
        rec7 = Recorder()
        s7 = run_pass(str(root), cfg, state, tp=rec7, now=t0 + timedelta(hours=24))
        check(s7["sent"] >= 1 and any("resend" in u for u, _ in rec7.calls), "a new bar's flip is sent again next day")

        # a failing channel is retried next pass; the others are not repeated
        cfg_fail = {"subscriptions": [{"id": "bad-hook", "watch": {"events": ["all"]}, "webhooks": [{"url": "http://127.0.0.1:9/nothing"}]}]}
        state2 = Path(tmp) / "state2"
        write_docs(root, base_events, [])
        run_pass(str(root), cfg_fail, state2, tp=Recorder(), now=t0)
        write_docs(root, ev2, [])

        class NoWait(Transport):
            def post(self, url, body, headers):
                req = urllib.request.Request(url, data=body, method="POST", headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=2) as fh:
                        return fh.status, ""
                except Exception as e:  # noqa: BLE001
                    return 0, str(e)

        s8 = run_pass(str(root), cfg_fail, state2, tp=NoWait(), now=t0 + timedelta(minutes=30))
        check(s8["failed"] >= 1 and s8["sent"] == 0, f"unreachable webhook counts as failed {s8}")
        st8 = load_state(state2) or {}
        check(not st8.get("sent"), "a failed send is not marked as sent")

    srv.shutdown()
    if failures:
        for f in failures:
            print("FAIL:", f)
        return 1
    print("self-test ok")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--docs", default=os.environ.get("ALERTS_FEED_BASE", "docs"), help="docs dir or Pages URL holding iq/*.json")
    ap.add_argument("--config", default=None, help="subscriptions JSON file (else ALERTS_CONFIG env)")
    ap.add_argument("--state", default=str(DEFAULT_STATE), help="state dir")
    ap.add_argument("--dry-run", action="store_true", help="print what would be sent; send and save nothing")
    ap.add_argument("--treat-all-new", action="store_true", help="with --dry-run: preview as if every fact on the board were new")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()
    if args.self_test:
        return self_test()
    cfg = load_config(args.config)
    if not cfg.get("subscriptions"):
        log("no subscriptions configured (set ALERTS_CONFIG); updating state only")
    run_pass(args.docs, cfg, Path(args.state), dry_run=args.dry_run, treat_all_new=args.treat_all_new and args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
