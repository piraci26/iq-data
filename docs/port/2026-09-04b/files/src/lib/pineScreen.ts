import type { Bar, Rows1m } from "@/lib/tht-api";
import { BARS_DAILY, BARS_WEEKLY, BARS_MONTHLY, IQ_BARS_1M, IQ_BARS_5M, rows1mToBars } from "@/lib/tht-api";
import { runPine, defaultTf, isIntradayTf, type PineRun, type RunTf } from "@/lib/pineRun";

/* Run a saved script across many symbols ("run it across my watchlist"):
   for each symbol fetch the daily bars, execute the script with the Pine
   runtime, and keep the names where it is signalling now. A strategy() is a
   hit while it holds a position; an indicator is a hit when a signal fired
   within the last few bars. Sequential with a small concurrency so the page
   stays responsive; abortable. */

export type ScriptHit = { sym: string; side: "BUY" | "SELL"; barsAgo: number };
export type ScreenProgress = { done: number; total: number; hits: number; failed: number };

const BARS_KEEP = 500;
const barsCache = new Map<string, Promise<Bar[] | null>>();

const urlFor = (sym: string, tf: RunTf) => (tf === "1" ? IQ_BARS_1M(sym) : tf === "5" ? IQ_BARS_5M(sym) : tf === "W" ? BARS_WEEKLY(sym) : tf === "M" ? BARS_MONTHLY(sym) : BARS_DAILY(sym));

/** bars for a symbol on a timeframe, cached per session */
export function loadBars(sym: string, tf: RunTf = "D"): Promise<Bar[] | null> {
  const key = `${tf}:${sym}`;
  let p = barsCache.get(key);
  if (!p) {
    p = fetch(urlFor(sym, tf))
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (!Array.isArray(b) || !b.length) return null;
        return isIntradayTf(tf) ? rows1mToBars(b as Rows1m) : (b as Bar[]);
      })
      .catch(() => null);
    barsCache.set(key, p);
  }
  return p;
}
export const loadDailyBars = (sym: string) => loadBars(sym, "D");

/** what the script says on the latest bar */
export function lastSignal(res: PineRun, n: number, lookback = 5): { side: "BUY" | "SELL"; barsAgo: number } | null {
  if (!res.ok) return null;
  if (res.kind === "strategy") {
    const pos = res.positions.pos;
    const last = pos[n - 1];
    if (!last) return null;
    let k = n - 1;
    while (k > 0 && pos[k - 1] === last) k--;
    return { side: last > 0 ? "BUY" : "SELL", barsAgo: n - 1 - k };
  }
  if (!res.signals) return null;
  for (let i = n - 1; i >= Math.max(0, n - lookback); i--) {
    const s = res.signals.sig[i];
    if (s) return { side: s > 0 ? "BUY" : "SELL", barsAgo: n - 1 - i };
  }
  return null;
}

export async function screenWithScript(
  code: string,
  syms: string[],
  opts: {
    loadBars?: (sym: string) => Promise<Bar[] | null>;
    lookback?: number;
    concurrency?: number;
    signal?: AbortSignal;
    onProgress?: (p: ScreenProgress, hits: Map<string, ScriptHit>) => void;
  } = {},
): Promise<Map<string, ScriptHit>> {
  const tf = defaultTf(code);
  const load = opts.loadBars ?? ((sym: string) => loadBars(sym, tf));
  const lookback = opts.lookback ?? (tf === "1" ? 60 : tf === "5" ? 12 : 5);
  const hits = new Map<string, ScriptHit>();
  const prog: ScreenProgress = { done: 0, total: syms.length, hits: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < syms.length) {
      if (opts.signal?.aborted) return;
      const sym = syms[next++];
      const bars = await load(sym);
      if (opts.signal?.aborted) return;
      if (bars && bars.length >= 60) {
        const slice = isIntradayTf(tf) ? bars : bars.length > BARS_KEEP ? bars.slice(-BARS_KEEP) : bars;
        const res = await runPine(code, slice, { timeframe: tf, sym });
        if (opts.signal?.aborted) return;
        if (!res.ok) prog.failed++;
        const sig = lastSignal(res, slice.length, lookback);
        if (sig) { hits.set(sym, { sym, ...sig }); prog.hits++; }
      } else prog.failed++;
      prog.done++;
      opts.onProgress?.({ ...prog }, hits);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 3, syms.length)) }, worker));
  return hits;
}
