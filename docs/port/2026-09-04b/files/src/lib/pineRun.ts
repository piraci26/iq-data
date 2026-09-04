import type { Bar } from "@/lib/tht-api";

/* Runs the user's ACTUAL Pine script over our bars with PineTS (the Pine
   v6 runtime), in the browser, loaded on demand. What comes back is what a
   backtester needs:
     - a strategy(): the positions its own strategy.entry/close calls took
     - an indicator(): a per-bar signal series read from what the script
       draws — plotshape/plotchar/plotarrow first, then alertcondition
       events, then the first two plotted lines crossing (or close crossing
       the only line)
   Nothing here guesses the logic; the script itself is executed. */

export type PineSig = { sig: number[]; source: string; oneSided: boolean; flat?: boolean[] };
export type PineSizing = { fraction: number; commissionBps: number; declared: boolean };

/* what the strategy() declaration says about size and costs */
export function sizingFromCode(code: string): PineSizing {
  const m = code.match(/^\s*strategy\s*\(([\s\S]*?)\)\s*$/m);
  if (!m) return { fraction: 1, commissionBps: 0, declared: false };
  const args = m[1];
  const num = (k: string) => { const r = args.match(new RegExp(`${k}\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`)); return r ? Number(r[1]) : undefined; };
  const qtyType = /default_qty_type\s*=\s*strategy\.percent_of_equity/.test(args);
  const qtyVal = num("default_qty_value");
  const fraction = qtyType && qtyVal != null ? Math.min(1, Math.max(0.01, qtyVal / 100)) : 1;
  const commPct = /commission_type\s*=\s*strategy\.commission\.percent/.test(args) ? num("commission_value") : undefined;
  return { fraction, commissionBps: commPct != null ? commPct * 100 : 0, declared: true };
}
export type PineFill = { dir: 1 | -1; entryIdx: number; exitIdx: number | null; entry: number; exit: number | null };
export type PinePos = { pos: number[]; source: string; trades: number; fills: PineFill[] };
export type PinePlot = { title: string; values: (number | null)[]; color?: string; overlay: boolean };
export type PineRun =
  | { ok: true; kind: "strategy"; positions: PinePos; signals: null; plots: PinePlot[]; warnings: string[]; ms: number }
  | { ok: true; kind: "indicator"; positions: null; signals: PineSig | null; plots: PinePlot[]; warnings: string[]; ms: number }
  | { ok: false; error: string };

type Runtime = typeof import("pinets");
let runtimeP: Promise<Runtime> | null = null;
const loadRuntime = () => (runtimeP ??= import("pinets"));

export type RunTf = "1" | "5" | "D" | "W" | "M";
export type RunOpts = { timeframe?: RunTf; sym?: string };
export const TF_LABEL: Record<RunTf, string> = { "1": "1-minute", "5": "5-minute", D: "daily", W: "weekly", M: "monthly" };
export const isIntradayTf = (tf: RunTf) => tf === "1" || tf === "5";
const SESSION_MS = 6.5 * 3600 * 1000; // 09:30 → 16:00 New York

/** our bars carry unix seconds; the runtime wants ms openTime and, per its
    provider contract, closeTime = the session close for stock bars */
export function toCandles(bars: Bar[], tf: RunTf = "D") {
  return bars.map((b) => {
    const openTime = b.time > 1e12 ? b.time : b.time * 1000;
    const closeTime = tf === "1" ? openTime + 60_000 : tf === "5" ? openTime + 300_000 : openTime + SESSION_MS;
    return { openTime, closeTime, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0 };
  });
}

/* A minimal provider so the runtime knows the exchange clock: without it
   hour/minute are UTC and every time-of-day script is silent. */
function nyProvider(candles: ReturnType<typeof toCandles>, sym: string) {
  return {
    async getMarketData() { return candles; },
    async getSymbolInfo() {
      return { ticker: sym, tickerid: `NASDAQ:${sym}`, main_tickerid: `NASDAQ:${sym}`, prefix: "NASDAQ", root: sym, type: "stock", description: sym, currency: "USD", basecurrency: "", country: "US", timezone: "America/New_York", session: "0930-1600", volumetype: "base", mintick: 0.01, minmove: 1, pricescale: 100, pointvalue: 1, mincontract: 1, isin: "", current_contract: "", industry: "", sector: "", employees: 0, shareholders: 0, shares_outstanding_float: 0, shares_outstanding_total: 0, expiration_date: 0, recommendations_buy: 0, recommendations_buy_strong: 0, recommendations_date: 0, recommendations_hold: 0, recommendations_sell: 0, recommendations_sell_strong: 0, recommendations_total: 0, target_price_average: 0, target_price_date: 0, target_price_estimates: 0, target_price_high: 0, target_price_low: 0, target_price_median: 0 };
    },
    configure() { /* nothing to configure */ },
  };
}

/* does the script decide by the clock? then daily bars have nothing to say */
const INTRADAY_RE = /\b(hour|minute|second)\b|\btime\s*\(\s*["'][^"']*["']\s*,\s*["']\d{4}-\d{4}|\bsession\.(ismarket|ispremarket|ispostmarket|isfirstbar|islastbar)|\binput\.session\b|\btimeframe\.isintraday\b|\btime_close\b/;
export const needsIntraday = (code: string) => INTRADAY_RE.test(code.replace(/\/\/.*$/gm, "").replace(/"[^"\n]*"|'[^'\n]*'/g, '""'));
/* clock-driven scripts default to the 60-day 5-minute history; the view falls back to 1-minute when a symbol has no 5m file */
export const defaultTf = (code: string): RunTf => (needsIntraday(code) ? "5" : "D");

export const isStrategyScript = (code: string) => /^\s*strategy\s*\(/m.test(code);

/* The runtime keys plots by title, so two untitled plotshape() calls land on
   the same key and only the first survives. Give every untitled plot-family
   call its own title before running. Real argument parsing: nested parens
   and string literals are respected; a call already carrying title= or a
   second positional string is left alone. */
const PLOT_FNS = /\b(plotshape|plotchar|plotarrow|plot)\(/g;
export function ensureTitles(code: string): string {
  const edits: { at: number; text: string }[] = [];
  const counts: Record<string, number> = {};
  let m: RegExpExecArray | null;
  while ((m = PLOT_FNS.exec(code))) {
    const fn = m[1];
    const open = m.index + m[0].length - 1; // the "("
    let depth = 0, i = open, quote: string | null = null;
    const argStarts: number[] = [open + 1];
    let close = -1;
    for (; i < code.length; i++) {
      const ch = code[i];
      if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) { close = i; break; } }
      else if (ch === "," && depth === 1) argStarts.push(i + 1);
      else if (ch === "\n" && depth === 1 && !/\s*[,)]/.test(code.slice(i + 1, i + 3)) && code.slice(open + 1, i).trim() === "") { /* tolerate a newline right after "(" */ }
    }
    if (close < 0) continue;
    const args = argStarts.map((s, k) => code.slice(s, k + 1 < argStarts.length ? argStarts[k + 1] - 1 : close).trim());
    const hasTitle = args.some((a) => /^title\s*=/.test(a)) || (args.length > 1 && /^["']/.test(args[1]));
    if (hasTitle) continue;
    counts[fn] = (counts[fn] ?? 0) + 1;
    edits.push({ at: close, text: `, title="${fn}#${counts[fn]}"` });
  }
  if (!edits.length) return code;
  let out = code;
  for (const e of edits.sort((a, b) => b.at - a.at)) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

type PlotEntry = { data?: { value: unknown }[]; options?: Record<string, unknown>; title?: string };

const LONG_RE = /\b(up|long|buy|bull|entry|enter)\b|_up\b|up$/i;
const SHORT_RE = /\b(down|dn|short|sell|bear)\b|_down\b|down$/i;
const EXIT_RE = /\b(exit|close|flat|tp|sl|stop|target)\b/i;

function shapeDirection(key: string, o: Record<string, unknown>): 1 | -1 | 0 {
  const hint = `${String(o.shape ?? "")} ${String(o.title ?? key)}`;
  if (LONG_RE.test(hint) && !SHORT_RE.test(hint)) return 1;
  if (SHORT_RE.test(hint) && !LONG_RE.test(hint)) return -1;
  const ch = String(o.char ?? o.text ?? "");
  if (/[▲△⬆↑]/.test(ch)) return 1;
  if (/[▼▽⬇↓]/.test(ch)) return -1;
  const loc = String(o.location ?? "").toLowerCase();
  if (loc.includes("below") || loc === "bottom") return 1;
  if (loc.includes("above") || loc === "top") return -1;
  return 0;
}

const isShapeStyle = (o: Record<string, unknown> | undefined) => /shape|char|arrow/i.test(String(o?.style ?? ""));

function numericPlots(plots: Record<string, PlotEntry>, n: number): PinePlot[] {
  const out: PinePlot[] = [];
  for (const [key, p] of Object.entries(plots)) {
    if (key.startsWith("__") || !p?.data || isShapeStyle(p.options)) continue;
    const values: (number | null)[] = new Array(n).fill(null);
    let numeric = 0;
    for (let i = 0; i < Math.min(n, p.data.length); i++) {
      const v = p.data[i]?.value;
      if (typeof v === "number" && Number.isFinite(v)) { values[i] = v; numeric++; }
    }
    if (numeric > 0) out.push({ title: p.title ?? key, values, color: typeof p.options?.color === "string" ? (p.options.color as string) : undefined, overlay: p.options?.overlay !== false });
  }
  return out;
}

const crossSig = (a: (number | null)[], b: (number | null)[], n: number) => {
  const sig = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const a0 = a[i - 1], a1 = a[i], b0 = b[i - 1], b1 = b[i];
    if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
    if (a0 <= b0 && a1 > b1) sig[i] = 1;
    else if (a0 >= b0 && a1 < b1) sig[i] = -1;
  }
  return sig;
};

function signalsFromPlots(
  plots: Record<string, PlotEntry>,
  alerts: { bar_index: number; title?: string; message?: string; id?: string }[],
  bars: Bar[],
  lines: PinePlot[],
): PineSig | null {
  const n = bars.length;
  /* 1. shapes the script draws */
  const longs: boolean[][] = [], shorts: boolean[][] = [], unknown: boolean[][] = [], exits: boolean[][] = [];
  const names: string[] = [];
  for (const [key, p] of Object.entries(plots)) {
    if (key.startsWith("__") || !p?.data || !isShapeStyle(p.options)) continue;
    const o = p.options ?? {};
    const arrow = /arrow/i.test(String(o.style ?? ""));
    const series = new Array<boolean>(n).fill(false);
    const seriesDn = new Array<boolean>(n).fill(false);
    for (let i = 0; i < Math.min(n, p.data.length); i++) {
      const v = p.data[i]?.value;
      if (arrow) { if (typeof v === "number" && v > 0) series[i] = true; else if (typeof v === "number" && v < 0) seriesDn[i] = true; }
      else if (v === true || (typeof v === "number" && v !== 0 && Number.isFinite(v))) series[i] = true;
    }
    if (arrow) { longs.push(series); shorts.push(seriesDn); names.push(p.title ?? key); continue; }
    /* "Exit long" / "Take profit" marks close the position instead of opening one */
    if (EXIT_RE.test(String(o.title ?? key))) { exits.push(series); names.push(p.title ?? key); continue; }
    const dir = shapeDirection(key, o);
    if (dir === 1) longs.push(series);
    else if (dir === -1) shorts.push(series);
    else unknown.push(series);
    names.push(p.title ?? key);
  }
  /* shapes with no readable direction only count when nothing else does:
     one such shape = long entries, two = long then short */
  if (!longs.length && !shorts.length && unknown.length) {
    longs.push(unknown[0]);
    if (unknown[1]) shorts.push(unknown[1]);
  }
  if (longs.length || shorts.length) {
    const sig = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const l = longs.some((s) => s[i]), s = shorts.some((x) => x[i]);
      sig[i] = l && !s ? 1 : s && !l ? -1 : 0;
    }
    const hasL = longs.some((s) => s.some(Boolean)), hasS = shorts.some((s) => s.some(Boolean));
    const flat = exits.length ? Array.from({ length: n }, (_, i) => exits.some((s) => s[i])) : undefined;
    return { sig, source: `shapes: ${names.slice(0, 3).join(", ")}`, oneSided: !(hasL && hasS), flat };
  }
  /* 2. alert conditions (runtime in "all" mode fires them on every bar) */
  if (alerts.length) {
    const sig = new Array(n).fill(0);
    const flat = new Array<boolean>(n).fill(false);
    let hasL = false, hasS = false, hasX = false;
    for (const a of alerts) {
      const i = a.bar_index;
      if (typeof i !== "number" || i < 0 || i >= n) continue;
      const hint = `${a.title ?? ""} ${a.message ?? ""} ${a.id ?? ""}`;
      if (EXIT_RE.test(hint) && !/\b(entry|enter)\b/i.test(hint)) { flat[i] = true; hasX = true; continue; }
      const d = SHORT_RE.test(hint) && !LONG_RE.test(hint) ? -1 : 1;
      sig[i] = d; if (d === 1) hasL = true; else hasS = true;
    }
    return { sig, source: "alert events", oneSided: !(hasL && hasS), flat: hasX ? flat : undefined };
  }
  /* 3. plotted lines crossing — price-pane lines only; an oscillator line
     crossing another oscillator line is fine, close crossing an RSI is not */
  if (lines.length >= 2 && lines[0].overlay === lines[1].overlay) return { sig: crossSig(lines[0].values, lines[1].values, n), source: `${lines[0].title} crossing ${lines[1].title}`, oneSided: false };
  if (lines.length === 1 && lines[0].overlay) return { sig: crossSig(bars.map((b) => b.close), lines[0].values, n), source: `close crossing ${lines[0].title}`, oneSided: false };
  return null;
}

type Trade = { entry_bar_index: number; exit_bar_index?: number; entry_price: number; exit_price?: number; size: number; status: "open" | "closed" };

/* the runtime reports the FILL bar (signal + 1) and the fill price, stops
   and limits included; keep those prices, the simulator uses them */
function positionsFromTrades(strategy: { closedtrades?: Trade[]; opentrades?: Trade[] }, n: number): PinePos {
  const pos = new Array(n).fill(0);
  const fills: PineFill[] = [];
  const all = [...(strategy.closedtrades ?? []), ...(strategy.opentrades ?? [])].sort((a, b) => a.entry_bar_index - b.entry_bar_index);
  for (const t of all) {
    const dir = t.size > 0 ? 1 : t.size < 0 ? -1 : 0;
    if (!dir) continue;
    const from = Math.max(0, t.entry_bar_index);
    const closed = t.status === "closed" && typeof t.exit_bar_index === "number";
    const to = closed ? Math.min(n, t.exit_bar_index as number) : n;
    for (let i = from; i < to; i++) pos[i] = dir;
    if (from < n) fills.push({ dir, entryIdx: from, exitIdx: closed ? Math.min(n - 1, t.exit_bar_index as number) : null, entry: t.entry_price, exit: closed && typeof t.exit_price === "number" ? t.exit_price : null });
  }
  return { pos, source: "the script's own strategy.entry / close calls", trades: all.length, fills };
}

/* what both runtimes hand back: the runtime context, trimmed */
type CtxLike = { plots?: Record<string, PlotEntry>; strategy?: unknown; alerts?: unknown[]; warnings?: { message: string }[] };

function interpret(ctx: CtxLike, code: string, bars: Bar[], ms: number): PineRun {
  const warnings = (ctx.warnings ?? []).slice(0, 5).map((w) => w.message);
  const plots = numericPlots((ctx.plots ?? {}) as Record<string, PlotEntry>, bars.length);
  if (ctx.strategy && isStrategyScript(code)) {
    return { ok: true, kind: "strategy", positions: positionsFromTrades(ctx.strategy as never, bars.length), signals: null, plots, warnings, ms };
  }
  const signals = signalsFromPlots((ctx.plots ?? {}) as Record<string, PlotEntry>, (ctx.alerts ?? []) as never, bars, plots);
  return { ok: true, kind: "indicator", positions: null, signals, plots, warnings, ms };
}

/* where the script runs: "local" bundles the runtime in the page (dev and
   the current default); "service" calls the pine-run edge function, the
   separately distributed program that embeds the AGPL runtime. Flip with
   VITE_PINE_RUNTIME=service once the function is deployed. */
const RUNTIME_MODE: "local" | "service" =
  ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_PINE_RUNTIME ?? "local") === "service" ? "service" : "local";
export const runtimeMode = () => RUNTIME_MODE;

async function runRemote(code: string, bars: Bar[], tf: RunTf, sym: string): Promise<PineRun> {
  const t0 = Date.now();
  try {
    const { supabase } = await import("@/integrations/supabase/client");
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return { ok: false, error: "sign in to run scripts" };
    const { data, error } = await supabase.functions.invoke("pine-run", {
      body: { code: ensureTitles(code), sym, tf, alertMode: "all", candles: bars.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume ?? 0]) },
      headers: { Authorization: `Bearer ${token}` },
    });
    if (error) return { ok: false, error: String((error as { message?: string }).message ?? error).slice(0, 240) };
    if (!data || typeof data !== "object") return { ok: false, error: "empty reply from the runtime service" };
    const d = data as { error?: string; ms?: number; ctx?: CtxLike };
    if (d.error) return { ok: false, error: String(d.error) };
    if (!d.ctx) return { ok: false, error: "no result from the runtime service" };
    return interpret(d.ctx, code, bars, d.ms ?? Date.now() - t0);
  } catch (e) {
    return { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 240) };
  }
}

export async function runPine(code: string, bars: Bar[], opts: RunOpts = {}): Promise<PineRun> {
  if (bars.length < 30) return { ok: false, error: "not enough bars" };
  const tf = opts.timeframe ?? "D";
  const sym = (opts.sym ?? "NVDA").toUpperCase();
  if (RUNTIME_MODE === "service") return runRemote(code, bars, tf, sym);
  let rt: Runtime;
  try {
    rt = await loadRuntime();
  } catch {
    return { ok: false, error: "the Pine runtime failed to load" };
  }
  const t0 = Date.now();
  try {
    const candles = toCandles(bars, tf);
    const p = new rt.PineTS(nyProvider(candles, sym) as never, `NASDAQ:${sym}`, tf, candles.length);
    p.setAlertMode("all");
    const ctx = await p.run(ensureTitles(code));
    return interpret(ctx as unknown as CtxLike, code, bars, Date.now() - t0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.replace(/\s+/g, " ").slice(0, 240) };
  }
}

/* ---- parameter sweep on the real script: the first numeric input ---- */
export type SweepParam = { label: string; value: number; start: number; end: number };

const CLOCK_INPUT = /hour|minute|second|time|session|day|date|month|year|start|end|qty|size|percent|risk|alert/i;
const LENGTH_INPUT = /len|length|period|window|lookback|bars|span|smooth|fast|slow|atr|ema|sma|rsi|mult|dev|factor|width/i;
export function findSweepParam(code: string): SweepParam | null {
  /* every numeric input; a length-like one wins, clock and sizing inputs are never swept */
  const re = /input(?:\.(?:int|float))?\(\s*(\d+(?:\.\d+)?)\s*(?:,\s*(?:title\s*=\s*)?"([^"]*)")?/g;
  const found: SweepParam[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const start = m.index + m[0].indexOf(m[1]);
    found.push({ label: m[2] || "input", value: Number(m[1]), start, end: start + m[1].length });
  }
  const pick = found.find((p) => LENGTH_INPUT.test(p.label) && !CLOCK_INPUT.test(p.label)) ?? found.find((p) => !CLOCK_INPUT.test(p.label));
  if (pick) return pick;
  const t = code.match(/ta\.(?:ema|sma|rma|wma|rsi|atr|stdev|highest|lowest|cci|mfi)\(\s*[\w.]+\s*,\s*(\d+)/);
  if (t && t.index != null) {
    const start = t.index + t[0].lastIndexOf(t[1]);
    return { label: "length", value: Number(t[1]), start, end: start + t[1].length };
  }
  return null;
}

export const withParam = (code: string, p: SweepParam, v: number) => code.slice(0, p.start) + String(v) + code.slice(p.end);
