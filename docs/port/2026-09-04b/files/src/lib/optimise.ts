import type { Bar } from "@/lib/tht-api";
import { runPine, type PineRun, type RunOpts } from "@/lib/pineRun";
import { backtestPositions, backtestSignals, backtestFills, type BtResult, type BtOpts } from "@/lib/manifestBacktest";

/* The optimiser: every input.int / input.float in the script is a knob.
   Each knob gets a handful of candidate values around its default (clipped
   to the script's own minval/maxval when given), the grid is capped, every
   combination is run through the real Pine runtime and the simulator, and
   the runs are ranked by net return penalised by drawdown with a minimum
   trade count. In-sample, no costs: a proposal to test, never a promise. */

export type OptParam = { label: string; kind: "int" | "float"; value: number; min?: number; max?: number; step?: number; start: number; end: number };
export type OptRun = { values: number[]; result: BtResult | null; score: number };
export type OptOutcome = { params: OptParam[]; baseline: OptRun; runs: OptRun[]; total: number };

const CALL_RE = /input\.(int|float)\(/g;

/* parse one call's arguments honouring nesting and strings */
function callArgs(code: string, open: number): { args: { text: string; start: number }[]; close: number } | null {
  let depth = 0, quote: string | null = null;
  const starts = [open + 1];
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (quote) { if (ch === "\\") i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") { depth--; if (depth === 0) return { args: starts.map((s, k) => ({ text: code.slice(s, k + 1 < starts.length ? starts[k + 1] - 1 : i).trim(), start: s })), close: i }; }
    else if (ch === "," && depth === 1) starts.push(i + 1);
  }
  return null;
}

export function findParams(code: string): OptParam[] {
  const out: OptParam[] = [];
  let m: RegExpExecArray | null;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(code))) {
    const kind = m[1] as "int" | "float";
    const open = m.index + m[0].length - 1;
    const parsed = callArgs(code, open);
    if (!parsed) continue;
    const first = parsed.args[0];
    const num = first.text.match(/^-?\d+(?:\.\d+)?$/);
    if (!num) continue; // defval is an expression: leave it alone
    const lit = first.text;
    const start = first.start + (code.slice(first.start, first.start + 40).indexOf(lit));
    const named = (k: string) => { const a = parsed.args.find((x) => new RegExp(`^${k}\\s*=`).test(x.text)); return a ? Number(a.text.split("=")[1]) : undefined; };
    const titleArg = parsed.args.find((x) => /^title\s*=/.test(x.text)) ?? (parsed.args[1] && /^["']/.test(parsed.args[1].text) ? parsed.args[1] : undefined);
    const label = titleArg ? titleArg.text.replace(/^title\s*=\s*/, "").replace(/^["']|["']$/g, "") : `${kind} #${out.length + 1}`;
    const num2 = (v: number | undefined) => (v != null && Number.isFinite(v) ? v : undefined);
    out.push({ label, kind, value: Number(lit), min: num2(named("minval")), max: num2(named("maxval")), step: num2(named("step")), start, end: start + lit.length });
  }
  return out;
}

/* candidate values for one knob: around the default, inside the declared range */
export function candidates(p: OptParam): number[] {
  const factors = [0.5, 0.75, 1, 1.5, 2];
  const lo = p.min ?? Math.min(p.kind === "int" ? 2 : 0.05, p.value);
  const hi = p.max ?? (p.kind === "int" ? Math.max(500, p.value * 4) : Math.max(100, p.value * 4));
  const step = p.step ?? (p.kind === "int" ? 1 : undefined);
  const round = (v: number) => {
    if (p.kind === "int") return Math.round(v);
    if (step) return Math.round(v / step) * step;
    return Number(v.toPrecision(3));
  };
  const vals = factors.map((f) => round(Math.min(hi, Math.max(lo, p.value * f))));
  if (p.value === 0) vals.push(...[1, 2, 3].map((v) => round(Math.min(hi, Math.max(lo, v)))));
  return [...new Set(vals)].sort((a, b) => a - b);
}

/* apply values to the source, from the end so offsets stay valid */
export function withParams(code: string, params: OptParam[], values: number[]): string {
  const order = params.map((p, i) => ({ p, v: values[i] })).sort((a, b) => b.p.start - a.p.start);
  let out = code;
  for (const { p, v } of order) out = out.slice(0, p.start) + String(v) + out.slice(p.end);
  return out;
}

export const btFromRun = (bars: Bar[], res: PineRun, bt?: BtOpts): BtResult | null =>
  !res.ok ? null
    : res.kind === "strategy" ? (res.positions.fills.length ? backtestFills(bars, res.positions.fills, res.positions.source, bt) : backtestPositions(bars, res.positions.pos, res.positions.source, bt))
    : res.signals ? backtestSignals(bars, res.signals.sig, res.signals.source, res.signals.oneSided, bt, res.signals.flat) : null;

/* net return with the drawdown counted against it; too few trades is disqualifying */
export function scoreOf(r: BtResult | null, minTrades: number): number {
  if (!r || r.trades.length < minTrades) return -Infinity;
  return r.netPct - 0.35 * r.maxDdPct;
}

/* deterministic sample so a rerun shows the same grid */
function lcg(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export function buildGrid(params: OptParam[], maxRuns: number): number[][] {
  const lists = params.map(candidates);
  let combos: number[][] = [[]];
  for (const l of lists) combos = combos.flatMap((c) => l.map((v) => [...c, v]));
  const base = params.map((p) => p.value);
  const isBase = (c: number[]) => c.every((v, i) => v === base[i]);
  const others = combos.filter((c) => !isBase(c));
  if (others.length + 1 <= maxRuns) return [base, ...others];
  const rnd = lcg(42);
  const picked: number[][] = [];
  const pool = [...others];
  while (picked.length < maxRuns - 1 && pool.length) picked.push(pool.splice(Math.floor(rnd() * pool.length), 1)[0]);
  return [base, ...picked];
}

export async function optimise(
  code: string,
  bars: Bar[],
  opts: { maxRuns?: number; minTrades?: number; run?: RunOpts; bt?: BtOpts; onProgress?: (done: number, total: number, best: OptRun | null) => void; signal?: AbortSignal } = {},
): Promise<OptOutcome | null> {
  const params = findParams(code).slice(0, 4);
  if (!params.length) return null;
  const minTrades = opts.minTrades ?? 8;
  const grid = buildGrid(params, opts.maxRuns ?? 60);
  const runs: OptRun[] = [];
  let best: OptRun | null = null;
  for (let i = 0; i < grid.length; i++) {
    if (opts.signal?.aborted) return null;
    const values = grid[i];
    const res = await runPine(withParams(code, params, values), bars, opts.run);
    const result = btFromRun(bars, res, opts.bt);
    const run: OptRun = { values, result, score: scoreOf(result, minTrades) };
    runs.push(run);
    if (!best || run.score > best.score) best = run;
    opts.onProgress?.(i + 1, grid.length, best);
  }
  const baseline = runs[0];
  runs.sort((a, b) => b.score - a.score);
  return { params, baseline, runs, total: grid.length };
}

/* ---- anchored walk-forward: fit on the past, judge on the unseen next slice ----
   The bars are cut into folds+1 equal slices. For each step the optimiser is
   run on everything before the slice, the winning values are then run through
   the slice it never saw, and compared with the current values on that same
   slice. "Held up" = the fitted values still beat the current ones out of
   sample. Prefix runs keep indicators warmed up; the out-of-sample return is
   read off the equity curve inside the test window. */
export type WfFold = { fold: number; trainTo: number; testFrom: number; testTo: number; values: number[]; isNet: number | null; oosNet: number | null; baseOosNet: number | null; oosTrades: number };
export type WfOutcome = { params: OptParam[]; folds: WfFold[]; heldUp: number };

const windowNet = (r: BtResult | null, from: number, to: number) => (r && from > 0 && to <= r.equity.length ? (r.equity[to - 1] / r.equity[from - 1] - 1) * 100 : null);

export async function walkForward(
  code: string,
  bars: Bar[],
  opts: { folds?: number; maxRuns?: number; minTrades?: number; run?: RunOpts; bt?: BtOpts; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<WfOutcome | null> {
  const params = findParams(code).slice(0, 4);
  if (!params.length || bars.length < 200) return null;
  const folds = Math.max(2, Math.min(4, opts.folds ?? 3));
  const seg = Math.floor(bars.length / (folds + 1));
  const out: WfFold[] = [];
  const base = params.map((p) => p.value);
  let done = 0; const total = folds;
  for (let f = 1; f <= folds; f++) {
    if (opts.signal?.aborted) return null;
    const trainTo = seg * f, testTo = f === folds ? bars.length : seg * (f + 1);
    const fit = await optimise(code, bars.slice(0, trainTo), { maxRuns: opts.maxRuns ?? 30, minTrades: opts.minTrades ?? 5, run: opts.run, bt: opts.bt, signal: opts.signal });
    if (!fit) return null;
    const values = fit.runs[0].values;
    const prefix = bars.slice(0, testTo);
    const fitted = btFromRun(prefix, await runPine(withParams(code, params, values), prefix, opts.run), opts.bt);
    const current = btFromRun(prefix, await runPine(withParams(code, params, base), prefix, opts.run), opts.bt);
    out.push({
      fold: f, trainTo, testFrom: trainTo, testTo, values,
      isNet: fit.runs[0].result?.netPct ?? null,
      oosNet: windowNet(fitted, trainTo, testTo),
      baseOosNet: windowNet(current, trainTo, testTo),
      oosTrades: fitted ? fitted.trades.filter((t) => t.exitIdx >= trainTo && t.exitIdx < testTo).length : 0,
    });
    opts.onProgress?.(++done, total);
  }
  const heldUp = out.filter((x) => x.oosNet != null && x.baseOosNet != null && x.oosNet > x.baseOosNet).length;
  return { params, folds: out, heldUp };
}
