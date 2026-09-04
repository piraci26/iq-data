import type { Bar } from "@/lib/tht-api";
import { wbSeries, wbSma, wbStdev, wbAtr, wbExtreme, type WbRender, type WbPlot } from "@/lib/pineRender";

/* One simulator, two ways in.
   - backtestPositions: a per-bar position series (what a strategy() script
     actually held, from its own entry/close calls)
   - backtestSignals: a per-bar signal series (+1 / -1 / 0) from what an
     indicator draws; two-sided signals flip on the opposite signal, one-sided
     signals hold for a fixed number of bars
   Fills at the next bar's open, mark-to-market every bar, no costs.
   backtestManifest keeps the old chart-manifest proxy for scripts the runtime
   cannot execute. */

export type BtTrade = { side: "long" | "short"; entryIdx: number; exitIdx: number; entry: number; exit: number; ret: number };
export type BtYear = { year: number; strat: number; bh: number };
export type BtResult = {
  trades: BtTrade[]; netPct: number; winRate: number; profitFactor: number; maxDdPct: number; buyHoldPct: number;
  equity: number[]; bhEquity: number[]; yearly: BtYear[]; beatYears: number; signalSource: string;
};
export type BtSweepPoint = { len: number; netPct: number; trades: number };

export const HOLD_BARS = 10;

/* trading costs and sizing applied by the simulator; the script's own
   strategy() declaration seeds these (see sizingFromCode) */
export type BtOpts = { commissionBps?: number; slippageBps?: number; fraction?: number };
const norm = (o?: BtOpts) => ({ c: Math.max(0, o?.commissionBps ?? 0) / 10000, sl: Math.max(0, o?.slippageBps ?? 0) / 10000, f: Math.min(1, Math.max(0.01, o?.fraction ?? 1)) });

function yearOf(b: Bar): number { const t = Number((b as unknown as { time: number }).time); return new Date((t > 1e12 ? t : t * 1000)).getUTCFullYear(); }

/* signals → positions. Two-sided: hold until the opposite signal. One-sided:
   hold HOLD_BARS bars, a repeat signal restarts the clock. */
export function signalsToPositions(sig: number[], oneSided: boolean, hold = HOLD_BARS, flat?: boolean[]): number[] {
  const n = sig.length;
  const pos = new Array(n).fill(0);
  let entry = -1;
  for (let i = 1; i < n; i++) {
    const want = sig[i - 1]; // acted on at this bar's open
    if (flat && flat[i - 1] && want === 0) { pos[i] = 0; continue; } // an explicit exit mark
    if (want !== 0) { pos[i] = want; entry = i; continue; }
    if (!oneSided) { pos[i] = pos[i - 1]; continue; }
    pos[i] = pos[i - 1] !== 0 && i - entry < hold ? pos[i - 1] : 0;
  }
  return pos;
}

/* positions → equity, trades and the by-year table. pos[i] is what is held
   through bar i, entered at bar i's open when it differs from pos[i-1]. */
export function backtestPositions(bars: Bar[], pos: number[], source: string, opts?: BtOpts): BtResult | null {
  const n = bars.length;
  if (n < 30 || pos.length !== n) return null;
  const { c, sl, f } = norm(opts);
  const trades: BtTrade[] = [];
  const equity: number[] = new Array(n).fill(1);
  let eq = 1, entryIdx = -1, entryPx = 0;
  for (let i = 1; i < n; i++) {
    const prev = pos[i - 1], cur = pos[i];
    if (prev !== 0) eq *= 1 + f * prev * ((bars[i].open - bars[i - 1].close) / bars[i - 1].close); // the gap into this open
    if (cur !== prev) {
      if (prev !== 0) {
        const exitPx = bars[i].open * (1 - prev * sl);
        eq *= 1 - f * c;
        trades.push({ side: prev === 1 ? "long" : "short", entryIdx, exitIdx: i, entry: entryPx, exit: exitPx, ret: prev * ((exitPx - entryPx) / entryPx) - 2 * c });
      }
      if (cur !== 0) { entryIdx = i; entryPx = bars[i].open * (1 + cur * sl); eq *= 1 - f * c; eq *= 1 + f * cur * ((bars[i].open - entryPx) / entryPx); }
    }
    if (cur !== 0) eq *= 1 + f * cur * ((bars[i].close - bars[i].open) / bars[i].open); // open to close
    equity[i] = eq;
  }
  if (pos[n - 1] !== 0 && entryIdx >= 0) { const px = bars[n - 1].close; trades.push({ side: pos[n - 1] === 1 ? "long" : "short", entryIdx, exitIdx: n - 1, entry: entryPx, exit: px, ret: pos[n - 1] * ((px - entryPx) / entryPx) }); }
  return finish(bars, equity, trades, eq, source);
}

/* stats, drawdown and the by-year table from an equity curve */
function finish(bars: Bar[], equity: number[], trades: BtTrade[], eq: number, source: string): BtResult {
  const n = bars.length;
  const bhEquity = bars.map((b) => b.close / bars[0].close);
  const wins = trades.filter((t) => t.ret > 0), losses = trades.filter((t) => t.ret <= 0);
  const gw = wins.reduce((a, t) => a + t.ret, 0), gl = Math.abs(losses.reduce((a, t) => a + t.ret, 0));
  let peak = 1, maxDd = 0; for (const e of equity) { peak = Math.max(peak, e); maxDd = Math.max(maxDd, (peak - e) / peak); }
  const years = new Map<number, { s0: number; s1: number; b0: number; b1: number }>();
  bars.forEach((b, i) => { const y = yearOf(b); const cur = years.get(y); if (!cur) years.set(y, { s0: equity[i], s1: equity[i], b0: b.close, b1: b.close }); else { cur.s1 = equity[i]; cur.b1 = b.close; } });
  const yearly: BtYear[] = [...years.entries()].map(([year, v]) => ({ year, strat: (v.s1 / v.s0 - 1) * 100, bh: (v.b1 / v.b0 - 1) * 100 })).filter((y) => Number.isFinite(y.year));
  return {
    trades, netPct: (eq - 1) * 100, winRate: trades.length ? (wins.length / trades.length) * 100 : 0, profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    maxDdPct: maxDd * 100, buyHoldPct: (bhEquity[n - 1] - 1) * 100, equity, bhEquity, yearly, beatYears: yearly.filter((y) => y.strat > y.bh).length, signalSource: source,
  };
}

/* a strategy's own fills: entries and exits at the prices the runtime
   reported (stops and limits included), marked to market on closes between
   them, 100% of equity per trade, long or short by the trade's sign */
export type BtFill = { dir: 1 | -1; entryIdx: number; exitIdx: number | null; entry: number; exit: number | null };
export function backtestFills(bars: Bar[], fills: BtFill[], source: string, opts?: BtOpts): BtResult | null {
  const n = bars.length;
  if (n < 30) return null;
  const { c, sl, f } = norm(opts);
  const equity: number[] = new Array(n).fill(1);
  const trades: BtTrade[] = [];
  const sorted = [...fills].filter((x) => x.entryIdx >= 0 && x.entryIdx < n).sort((a, b) => a.entryIdx - b.entryIdx);
  /* one open trade at a time (overlapping fills are taken in sequence) */
  const st: { open: BtFill | null; mark: number; eq: number; k: number } = { open: null, mark: 0, eq: 1, k: 0 };
  const take = () => { const o = sorted[st.k++]; st.open = o; st.mark = o.entry * (1 + o.dir * sl); st.eq *= 1 - f * c; };
  for (let i = 1; i < n; i++) {
    if (!st.open && st.k < sorted.length && sorted[st.k].entryIdx <= i) take();
    const o = st.open;
    if (o) {
      const exitHere = o.exitIdx != null && o.exitIdx <= i;
      const px = exitHere ? (o.exit ?? bars[i].open) * (1 - o.dir * sl) : bars[i].close;
      st.eq *= 1 + f * o.dir * ((px - st.mark) / st.mark);
      st.mark = px;
      if (exitHere) {
        st.eq *= 1 - f * c;
        const entryPx = o.entry * (1 + o.dir * sl);
        trades.push({ side: o.dir === 1 ? "long" : "short", entryIdx: o.entryIdx, exitIdx: i, entry: entryPx, exit: px, ret: o.dir * ((px - entryPx) / entryPx) - 2 * c });
        st.open = null;
        /* a new trade filled on the same bar picks up from here */
        if (st.k < sorted.length && sorted[st.k].entryIdx <= i) take();
      }
    }
    equity[i] = st.eq;
  }
  const o = st.open;
  if (o) { const px = bars[n - 1].close; trades.push({ side: o.dir === 1 ? "long" : "short", entryIdx: o.entryIdx, exitIdx: n - 1, entry: o.entry, exit: px, ret: o.dir * ((px - o.entry) / o.entry) }); }
  return finish(bars, equity, trades, st.eq, source);
}

export function backtestSignals(bars: Bar[], sig: number[], source: string, oneSided = false, opts?: BtOpts, flat?: boolean[]): BtResult | null {
  if (sig.length !== bars.length) return null;
  const hasExits = !!flat && flat.some(Boolean);
  return backtestPositions(bars, signalsToPositions(sig, oneSided && !hasExits, HOLD_BARS, flat), oneSided && !hasExits ? `${source} · one-sided, ${HOLD_BARS}-bar hold` : source, opts);
}

/* ---- the manifest proxy (chart primitives → signals) ---- */
function manifestSignals(bars: Bar[], render: WbRender): { sig: number[]; source: string } | null {
  const close = bars.map((b) => b.close);
  const cross = (a: (number | null)[], b: (number | null)[]) => {
    const sig = new Array(bars.length).fill(0);
    for (let i = 1; i < bars.length; i++) {
      const a0 = a[i - 1], a1 = a[i], b0 = b[i - 1], b1 = b[i];
      if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
      if (a0 <= b0 && a1 > b1) sig[i] = 1;
      else if (a0 >= b0 && a1 < b1) sig[i] = -1;
    }
    return sig;
  };
  const band = (up: (number | null)[], dn: (number | null)[], label: string) => {
    const sig = new Array(bars.length).fill(0);
    for (let i = 1; i < bars.length; i++) {
      const u0 = up[i - 1], u1 = up[i], d0 = dn[i - 1], d1 = dn[i];
      if (u0 == null || u1 == null || d0 == null || d1 == null) continue;
      if (close[i - 1] <= u0 && close[i] > u1) sig[i] = 1;
      else if (close[i - 1] >= d0 && close[i] < d1) sig[i] = -1;
    }
    return { sig, source: label };
  };
  for (const p of render.plots) {
    if (p.kind === "marks") return { sig: cross(wbSeries(bars, p.a), wbSeries(bars, p.b)), source: "marks: a crossing b" };
  }
  for (const p of render.plots) {
    if (p.kind === "bb") { const basis = wbSma(close, p.len), sd = wbStdev(bars, p.len); return band(basis.map((v, i) => (v != null && sd[i] != null ? v + p.mult * (sd[i] as number) : null)), basis.map((v, i) => (v != null && sd[i] != null ? v - p.mult * (sd[i] as number) : null)), `close breaking the ${p.len}/${p.mult} bands`); }
    if (p.kind === "atrband") { const basis = wbSeries(bars, { calc: "ema", len: p.len }), atr = wbAtr(bars, p.len); return band(basis.map((v, i) => (v != null && atr[i] != null ? v + p.mult * (atr[i] as number) : null)), basis.map((v, i) => (v != null && atr[i] != null ? v - p.mult * (atr[i] as number) : null)), `close breaking the ${p.len} ATR band`); }
    if (p.kind === "donchian") { const hi = wbExtreme(bars, p.len, true), lo = wbExtreme(bars, p.len, false); return band(hi.map((_, i) => (i > 0 ? hi[i - 1] : null)), lo.map((_, i) => (i > 0 ? lo[i - 1] : null)), `close breaking the ${p.len}-bar channel`); }
  }
  for (const p of render.plots) {
    if (p.kind === "line") return { sig: cross(close.map((c) => c as number | null), wbSeries(bars, { calc: p.calc, len: p.len })), source: `close crossing the ${p.len} ${p.calc.toUpperCase()}` };
  }
  return null;
}

export function backtestManifest(bars: Bar[], render: WbRender | null): BtResult | null {
  if (!render || bars.length < 60) return null;
  const s = manifestSignals(bars, render);
  return s ? backtestSignals(bars, s.sig, s.source) : null;
}

/* the manifest's main length, and the manifest with every length replaced */
export function primaryLen(render: WbRender | null): number | null {
  if (!render) return null;
  for (const p of render.plots) { if ("len" in p && typeof p.len === "number") return p.len; if (p.kind === "marks") { const a = p.a, b = p.b; if (typeof a === "object") return a.len; if (typeof b === "object") return b.len; } }
  return null;
}
export function withLen(render: WbRender, len: number): WbRender {
  const base = primaryLen(render) ?? len;
  const scale = (l: number) => Math.max(2, Math.round((l / base) * len));
  const plots = render.plots.map((p): WbPlot => {
    if (p.kind === "marks") return { kind: "marks", a: typeof p.a === "object" ? { ...p.a, len: scale(p.a.len) } : p.a, b: typeof p.b === "object" ? { ...p.b, len: scale(p.b.len) } : p.b };
    if ("len" in p) return { ...p, len: scale(p.len) } as WbPlot;
    return p;
  });
  return { plots };
}
export function sweepLen(bars: Bar[], render: WbRender, lens: number[]): BtSweepPoint[] {
  return lens.map((len) => { const r = backtestManifest(bars, withLen(render, len)); return { len, netPct: r ? r.netPct : 0, trades: r ? r.trades.length : 0 }; });
}

/* ---- the plain-language read every backtest gets ---- */
export type BtVerdict = "strong" | "edge" | "weak" | "failed" | "thin";
export function basicSummary(r: BtResult, sym: string, barsCount: number, tfLabel = "daily"): { verdict: BtVerdict; headline: string; text: string } {
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
  const t = r.trades.length;
  const pf = Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞";
  const years = r.yearly.length;
  let verdict: BtVerdict;
  if (t < 10) verdict = "thin";
  else if (r.netPct <= 0 || r.profitFactor < 1) verdict = "failed";
  else if (r.netPct > r.buyHoldPct && r.profitFactor >= 1.5 && r.maxDdPct < 35) verdict = "strong";
  else if (r.netPct >= 0.5 * r.buyHoldPct && r.beatYears * 2 >= years && r.maxDdPct < 45) verdict = "edge";
  else verdict = "weak";
  const headline = {
    thin: "TOO FEW TRADES TO JUDGE",
    failed: "NOT TRADEABLE AS IS",
    weak: "WEAK · BUY-AND-HOLD WINS",
    edge: "AN EDGE · CONFIRM OUT OF SAMPLE",
    strong: "STRONG IN SAMPLE · NOW BREAK IT",
  }[verdict];
  const text = `Over ${barsCount} ${tfLabel} bars on ${sym} the script took ${t} trade${t === 1 ? "" : "s"} and ${r.netPct >= 0 ? "made" : "lost"} ${pct(r.netPct).replace("-", "")} while buy-and-hold made ${pct(r.buyHoldPct)}. Win rate ${r.winRate.toFixed(0)}%, profit factor ${pf}, worst drawdown ${r.maxDdPct.toFixed(0)}%. It beat buy-and-hold in ${r.beatYears} of ${years} year${years === 1 ? "" : "s"}.${verdict === "thin" ? " Ten trades is the floor for any conclusion." : ""}`;
  return { verdict, headline, text };
}
