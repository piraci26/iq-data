import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { barsDailyQuery, barsWeeklyQuery, barsMonthlyQuery, iqBars1mQuery, iqBars5mQuery, rows1mToBars } from "@/lib/tht-api";
import { listScripts, deleteScript, diffLines, nameFromCode, saveScript, addVersion, latestVersion, type SavedScript, type ScriptVersion } from "@/lib/scriptLibrary";
import { auditPine, type AuditFinding } from "@/lib/pineAudit";
import { backtestManifest, backtestPositions, backtestSignals, backtestFills, basicSummary, type BtResult, type BtOpts } from "@/lib/manifestBacktest";
import { runPine, findSweepParam, withParam, defaultTf, needsIntraday, isIntradayTf, sizingFromCode, TF_LABEL, type PineRun, type RunTf } from "@/lib/pineRun";
import { loadBars } from "@/lib/pineScreen";
import { optimise, walkForward, findParams, withParams, type OptOutcome, type OptRun, type WfOutcome } from "@/lib/optimise";
import type { WbRender } from "@/lib/pineRender";
import type { Bar } from "@/lib/tht-api";

/* The Quant views: the audit, the backtest, the code and the version
   history of ONE script. The copilot workbench uses AuditView and
   BacktestView on the script that was just built; the Backtest panel and
   the saved-scripts library use them on any version. Tokens are the app's
   --iq-* vars so the views follow the theme wherever they are mounted. */

const MONO = "'IBM Plex Mono', monospace", SANS = "'DM Sans', sans-serif";
const C = { ink: "var(--iq-ink)", muted: "var(--iq-muted)", faint: "var(--iq-faint)", line: "var(--iq-line)", card: "var(--iq-card)", surface: "var(--iq-surface)", steel: "#3D69A8", up: "#089981", down: "#F23645", amber: "#FFAA00" };
const sevColor = (s: AuditFinding["severity"]) => (s === "pass" ? C.up : s === "warn" ? C.amber : C.down);
const label: React.CSSProperties = { fontFamily: MONO, fontSize: 10, letterSpacing: ".14em", color: C.faint };
const pill = (on: boolean): React.CSSProperties => ({ borderRadius: 999, border: `1px solid ${on ? "rgba(61,105,168,.4)" : C.line}`, background: on ? "rgba(61,105,168,.1)" : "transparent", padding: "5px 12px", fontFamily: MONO, fontSize: 10, letterSpacing: ".1em", color: on ? C.ink : C.faint, cursor: "pointer" });
const primaryBtn: React.CSSProperties = { borderRadius: 999, border: "none", background: C.steel, color: "#fff", padding: "8px 16px", fontFamily: SANS, fontSize: 13, fontWeight: 700, cursor: "pointer" };
const secondaryBtn: React.CSSProperties = { borderRadius: 999, border: `1px solid ${C.steel}`, background: "transparent", color: C.steel, padding: "6px 13px", fontFamily: SANS, fontSize: 12.5, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" };
const linkBtn: React.CSSProperties = { background: "transparent", border: "none", color: C.steel, fontFamily: SANS, fontSize: 13.5, fontWeight: 600, cursor: "pointer", padding: 0, whiteSpace: "nowrap" };
/* readable text: sentence case, sans, muted */
const sub: React.CSSProperties = { fontFamily: SANS, fontSize: 13, color: C.muted, lineHeight: 1.5 };
const chip = (color: string): React.CSSProperties => ({ fontFamily: SANS, fontSize: 11.5, fontWeight: 600, color, background: `${color}14`, border: `1px solid ${color}44`, borderRadius: 999, padding: "3px 9px", whiteSpace: "nowrap" });
const dot = (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 });
const sentence = (t: string) => t.charAt(0) + t.slice(1).toLowerCase();
const CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%235C6E93' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>\")";
const selectStyle: React.CSSProperties = { appearance: "none", WebkitAppearance: "none", borderRadius: 10, border: `1px solid ${C.line}`, backgroundColor: C.card, backgroundImage: CHEVRON, backgroundRepeat: "no-repeat", backgroundPosition: "right 11px center", padding: "8px 34px 8px 12px", fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: C.ink, maxWidth: 340, cursor: "pointer" };
const fmtDate = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: "2-digit", month: "short" });
const fmtBarDate = (b: Bar | undefined) => (b ? new Date((b.time > 1e12 ? b.time : b.time * 1000)).toISOString().slice(0, 10) : "—");
const pct = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`);

/* what the Backtest panel hands the desk when the user wants a fix in the creator chat */
export type FixContext = { script: SavedScript | null; version: ScriptVersion | null; code: string; findings: AuditFinding[] };

/* the message that lands, pre-typed, in the creator chat's composer */
export function fixRequestText(ctx: FixContext, includeCode: boolean): string {
  const issues = ctx.findings.filter((f) => f.severity !== "pass");
  const head = ctx.script ? `Fix these audit findings in "${ctx.script.name}"${ctx.version ? ` (v${ctx.version.v})` : ""} and keep everything else the same:` : "Fix these audit findings in the script below and keep everything else the same:";
  const lines = issues.map((f, i) => `${i + 1}) ${f.line != null ? `line ${f.line}, ` : ""}${sentence(f.tag)}: ${f.why}`);
  const tail = "Return the full corrected Pine v6 script.";
  /* the chat composer is a single line; the code, when included, goes to the multi-line start composer */
  return includeCode ? [head, ...lines, tail, "", ctx.code].join("\n") : [head, ...lines, tail].join(" ");
}

/* ---------------- AUDIT ---------------- */
export function AuditView({ code }: { code: string }) {
  const audit = useMemo(() => auditPine(code), [code]);
  const byLine = new Map<number, AuditFinding>();
  for (const f of audit.findings) if (f.line != null && !byLine.has(f.line)) byLine.set(f.line, f);
  const vc = audit.verdict === "clean" ? C.up : audit.verdict === "check" ? C.amber : C.down;
  return (
    <div className="iq-q-audit" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.3fr) minmax(260px, 1fr)", fontFamily: SANS, color: C.ink }}>
      <style>{`@media (max-width: 960px) { .iq-q-audit { grid-template-columns: 1fr !important; } }`}</style>
      <pre style={{ margin: 0, padding: "14px 16px", overflow: "auto", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.7, borderRight: `1px solid ${C.line}` }}>
        {code.split(/\r?\n/).map((ln, i) => { const f = byLine.get(i + 1); return (
          <div key={i} style={{ display: "flex", gap: 12, background: f ? `${sevColor(f.severity)}14` : "transparent", borderLeft: `2px solid ${f ? sevColor(f.severity) : "transparent"}`, marginLeft: -12, paddingLeft: 10, whiteSpace: "pre" }}>
            <span style={{ color: C.faint, width: 22, textAlign: "right", flex: "0 0 auto" }}>{i + 1}</span><span style={{ color: f ? C.ink : C.muted }}>{ln}</span>
          </div>
        ); })}
      </pre>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10, background: C.surface }}>
        <div style={label}>FINDINGS · {audit.findings.length}</div>
        {audit.findings.map((f, i) => (
          <div key={i} style={{ padding: "9px 11px", borderRadius: 10, border: `1px solid ${sevColor(f.severity)}55`, background: `${sevColor(f.severity)}12` }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontFamily: MONO, fontSize: 10.5, letterSpacing: ".1em", color: sevColor(f.severity) }}><span>{f.severity === "pass" ? "✓ " : f.severity === "warn" ? "! " : "✕ "}{f.tag}</span><span style={{ color: C.faint }}>{f.line != null ? `L${f.line}` : ""}</span></div>
            <div style={{ fontSize: 12.5, color: C.muted, marginTop: 3, lineHeight: 1.45 }}>{f.why}</div>
          </div>
        ))}
        <div style={{ marginTop: "auto", paddingTop: 12, borderTop: `1px solid ${C.line}` }}>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".08em", color: vc }}>● {audit.headline}</div>
          <div style={{ ...label, marginTop: 4 }}>{audit.detail.toUpperCase()}</div>
        </div>
      </div>
    </div>
  );
}

/* the audit as a strip on top of every backtest: verdict, the failing and
   doubtful lines, and the door back to the chat that built the script */
function AuditStrip({ code, onFix }: { code: string; onFix?: (findings: AuditFinding[]) => void }) {
  const audit = useMemo(() => auditPine(code), [code]);
  const issues = audit.findings.filter((f) => f.severity !== "pass");
  const vc = audit.verdict === "clean" ? C.up : audit.verdict === "check" ? C.amber : C.down;
  return (
    <div style={{ borderRadius: 12, border: `1px solid ${vc}40`, background: `${vc}0C`, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: vc }}>
        <span style={dot(vc)} />
        Audit: {sentence(audit.headline)}
      </span>
      {issues.map((f, i) => (
        <span key={i} title={f.why} style={chip(sevColor(f.severity))}>
          {f.line != null ? `L${f.line} · ` : ""}{sentence(f.tag)}
        </span>
      ))}
      {issues.length === 0 && <span style={sub}>{audit.findings.length} checks passed</span>}
      {issues.length > 0 && onFix && (
        <button type="button" onClick={() => onFix(audit.findings)} style={{ ...secondaryBtn, marginLeft: "auto" }}>
          Fix it in the creator chat →
        </button>
      )}
    </div>
  );
}

/* ---------------- BACKTEST ----------------
   The script itself is executed by the Pine runtime over our daily bars.
   A strategy() trades from its own entry/close calls; an indicator trades
   from what it draws (shapes, alert conditions, plotted lines). Every run
   gets the audit strip, a plain summary, the stats, the equity curve, the
   by-year table, a sweep of the first input, the same script across a
   basket, a trade log, and the optimiser on demand. The chart-manifest
   proxy is only shown, labelled, when the runtime cannot run the script. */
type Engine =
  | { kind: "pine"; source: string; ms: number; scriptKind: "strategy" | "indicator" }
  | { kind: "proxy"; error: string }
  | { kind: "none"; error: string };
type SweepOut = { label: string; points: { len: number; netPct: number; trades: number }[] };
type BasketRow = { sym: string; netPct: number | null; bhPct: number | null; trades: number };
type RunState = { key: string; engine: Engine; result: BtResult | null; sweep: SweepOut | null; basket: BasketRow[]; busy: boolean };
type OptState = { running: boolean; done: number; total: number; outcome: OptOutcome | null; error: string | null };
type WfState = { running: boolean; done: number; total: number; outcome: WfOutcome | null; error: string | null };
const COST_STEPS = [0, 2, 5, 10];

export const BASKET = ["NVDA", "AAPL", "MSFT", "AMZN", "META", "TSLA", "AMD", "GOOGL"];

/** one backtest from one runtime result */
export function backtestRun(bars: Bar[], res: PineRun, bt?: BtOpts): BtResult | null {
  if (!res.ok) return null;
  if (res.kind === "strategy") return res.positions.fills.length ? backtestFills(bars, res.positions.fills, res.positions.source, bt) : backtestPositions(bars, res.positions.pos, res.positions.source, bt);
  return res.signals ? backtestSignals(bars, res.signals.sig, res.signals.source, res.signals.oneSided, bt, res.signals.flat) : null;
}

export function BacktestView({ name, vLabel, code, render, onFix, onAccept }: {
  name: string; vLabel: string; code: string; render: WbRender | null;
  /** send the audit findings to the chat that built the script */
  onFix?: (findings: AuditFinding[]) => void;
  /** file the optimiser's proposal as a new version */
  onAccept?: (newCode: string, note: string) => void;
}) {
  const [sym, setSym] = useState("NVDA");
  const [draft, setDraft] = useState("NVDA");
  /* the timeframe the script needs: time-of-day scripts get 1-minute bars */
  const intraday = useMemo(() => needsIntraday(code), [code]);
  const [tf, setTf] = useState<RunTf>(() => defaultTf(code));
  useEffect(() => { setTf(defaultTf(code)); }, [code]);
  const dailyQ = useQuery({ ...barsDailyQuery(sym), retry: 1, enabled: tf === "D" });
  const weeklyQ = useQuery({ ...barsWeeklyQuery(sym), retry: 1, enabled: tf === "W" });
  const monthlyQ = useQuery({ ...barsMonthlyQuery(sym), retry: 1, enabled: tf === "M" });
  const minuteQ = useQuery({ ...iqBars1mQuery(sym), retry: 1, enabled: tf === "1" });
  const fiveQ = useQuery({ ...iqBars5mQuery(sym), retry: 0, enabled: tf === "5" });
  /* no 5-minute file yet for this symbol (the pipeline writes them once a session): fall back to the minute feed */
  useEffect(() => { if (tf === "5" && fiveQ.isError) setTf("1"); }, [tf, fiveQ.isError]);
  const barsQ = tf === "1" ? minuteQ : tf === "5" ? fiveQ : tf === "W" ? weeklyQ : tf === "M" ? monthlyQ : dailyQ;
  const bars = useMemo<Bar[]>(() => (tf === "1" ? (minuteQ.data ? rows1mToBars(minuteQ.data) : []) : tf === "5" ? (fiveQ.data ? rows1mToBars(fiveQ.data) : []) : (((tf === "W" ? weeklyQ.data : tf === "M" ? monthlyQ.data : dailyQ.data) as Bar[] | undefined) ?? [])), [tf, minuteQ.data, fiveQ.data, weeklyQ.data, monthlyQ.data, dailyQ.data]);
  const sessions = useMemo(() => (isIntradayTf(tf) ? new Set(bars.map((b) => new Date(b.time > 1e12 ? b.time : b.time * 1000).toISOString().slice(0, 10))).size : 0), [tf, bars]);
  const runOpts = useMemo(() => ({ timeframe: tf, sym }), [tf, sym]);
  const optimiserOk = !isIntradayTf(tf) || sessions >= 20;
  /* costs and size: seeded from the strategy() declaration, adjustable */
  const sizing = useMemo(() => sizingFromCode(code), [code]);
  const [costBps, setCostBps] = useState<number>(() => Math.round(sizing.commissionBps));
  useEffect(() => { setCostBps(Math.round(sizing.commissionBps)); }, [sizing.commissionBps]);
  const btOpts = useMemo<BtOpts>(() => ({ commissionBps: costBps, slippageBps: costBps ? Math.round(costBps / 2) : 0, fraction: sizing.fraction }), [costBps, sizing.fraction]);
  const [run, setRun] = useState<RunState | null>(null);
  const [opt, setOpt] = useState<OptState | null>(null);
  const [wf, setWf] = useState<WfState | null>(null);
  const wfAbort = useRef<AbortController | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const optAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!bars.length) return;
    const key = `${tf}|${sym}|${bars.length}|${code.length}|${code.slice(0, 64)}|${costBps}|${sizing.fraction}`;
    let alive = true;
    const patch = (f: (r: RunState) => RunState) => setRun((r) => (r && r.key === key && alive ? f(r) : r));
    setRun({ key, engine: { kind: "none", error: "" }, result: null, sweep: null, basket: [], busy: true });
    setOpt(null); optAbort.current?.abort(); setWf(null); wfAbort.current?.abort();
    (async () => {
      const res = await runPine(code, bars, runOpts);
      if (!alive) return;
      let engine: Engine;
      let result: BtResult | null = null;
      if (res.ok) {
        result = backtestRun(bars, res, btOpts);
        if (result) engine = { kind: "pine", source: result.signalSource, ms: res.ms, scriptKind: res.kind };
        else engine = { kind: "none", error: "The script ran but draws nothing the tester can trade from. Add plotshape or plotchar for the entries, an alertcondition, or make it a strategy()." };
      } else {
        result = backtestManifest(bars, render);
        engine = result ? { kind: "proxy", error: res.error } : { kind: "none", error: `The runtime could not run this script: ${res.error}` };
      }
      patch((r) => ({ ...r, engine, result, busy: engine.kind === "pine" }));
      if (engine.kind !== "pine") return;
      const p = findSweepParam(code);
      if (p) {
        const vals = [...new Set([0.5, 0.75, 1, 1.25, 1.5, 2].map((f) => Math.max(2, Math.round(p.value * f))))].sort((a, b) => a - b);
        const points: SweepOut["points"] = [];
        for (const v of vals) {
          const r2 = await runPine(withParam(code, p, v), bars, runOpts);
          if (!alive) return;
          const bt = backtestRun(bars, r2, btOpts);
          points.push({ len: v, netPct: bt?.netPct ?? 0, trades: bt?.trades.length ?? 0 });
          patch((r) => ({ ...r, sweep: { label: p.label, points: [...points] } }));
        }
      }
      const basket: BasketRow[] = [];
      for (const s of BASKET) {
        if (s === sym) continue;
        const b = await loadBars(s, tf);
        if (!alive) return;
        if (!b || b.length < 60) continue;
        const r3 = await runPine(code, b, { timeframe: tf, sym: s });
        if (!alive) return;
        const bt = backtestRun(b, r3, btOpts);
        basket.push({ sym: s, netPct: bt?.netPct ?? null, bhPct: bt?.buyHoldPct ?? null, trades: bt?.trades.length ?? 0 });
        patch((r) => ({ ...r, basket: [...basket] }));
      }
      patch((r) => ({ ...r, busy: false }));
    })();
    return () => { alive = false; };
  }, [bars, code, render, sym, tf, runOpts, btOpts, costBps, sizing.fraction]);

  const params = useMemo(() => findParams(code).slice(0, 4), [code]);
  const runOptimiser = () => {
    if (!bars.length || !params.length) return;
    optAbort.current?.abort();
    const ac = new AbortController(); optAbort.current = ac;
    setOpt({ running: true, done: 0, total: 0, outcome: null, error: null });
    optimise(code, bars, { maxRuns: 60, minTrades: 8, run: runOpts, bt: btOpts, signal: ac.signal, onProgress: (done, total) => { if (!ac.signal.aborted) setOpt((o) => (o ? { ...o, done, total } : o)); } })
      .then((outcome) => { if (!ac.signal.aborted) setOpt({ running: false, done: outcome?.total ?? 0, total: outcome?.total ?? 0, outcome, error: outcome ? null : "No numeric inputs to optimise." }); })
      .catch((e) => { if (!ac.signal.aborted) setOpt({ running: false, done: 0, total: 0, outcome: null, error: e instanceof Error ? e.message : String(e) }); });
  };

  const runWalkForward = () => {
    if (!bars.length || !params.length) return;
    wfAbort.current?.abort();
    const ac = new AbortController(); wfAbort.current = ac;
    setWf({ running: true, done: 0, total: 3, outcome: null, error: null });
    walkForward(code, bars, { folds: 3, maxRuns: 30, minTrades: 5, run: runOpts, bt: btOpts, signal: ac.signal, onProgress: (done, total) => { if (!ac.signal.aborted) setWf((w) => (w ? { ...w, done, total } : w)); } })
      .then((outcome) => { if (!ac.signal.aborted) setWf({ running: false, done: 3, total: 3, outcome, error: outcome ? null : "Needs at least 200 bars and a numeric input." }); })
      .catch((e) => { if (!ac.signal.aborted) setWf({ running: false, done: 0, total: 3, outcome: null, error: e instanceof Error ? e.message : String(e) }); });
  };

  const result = run?.result ?? null;
  const engine = run?.engine ?? null;
  const sweep = run?.sweep ?? null;
  const basket = run?.basket ?? [];
  const summary = result ? basicSummary(result, sym, bars.length, TF_LABEL[tf]) : null;
  const noTrades = !!result && result.trades.length === 0;
  /* a clock-driven script on bars without a clock: every daily bar reads
     09:30 and the exit time never arrives, so any number would be a lie */
  const wrongTf = intraday && !isIntradayTf(tf);
  const commit = () => { const s = draft.trim().toUpperCase(); if (/^[A-Z0-9.-]{1,12}$/.test(s)) setSym(s); else setDraft(sym); };
  const stat = (l: string, v: string, c = C.ink) => (
    <div style={{ padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface }}>
      <div style={label}>{l}</div>
      <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 600, color: c, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{v}</div>
    </div>
  );
  const W = 600, H = 160;
  const curve = (arr: number[]) => { const lo = Math.min(...arr), hi = Math.max(...arr); return arr.map((v, i) => `${(i / (arr.length - 1)) * W},${H - ((v - lo) / (hi - lo || 1)) * (H - 8) - 4}`).join(" "); };
  const pts = sweep?.points ?? [];
  const best = pts.length ? pts.reduce((a, b) => (b.netPct > a.netPct ? b : a)) : null;
  const plateau = best ? pts.filter((p) => Math.abs(p.len - best.len) <= Math.max(2, Math.round(best.len * 0.25)) && p.netPct > 0).length : 0;
  const verdictColor = summary ? ({ strong: C.up, edge: C.up, weak: C.amber, failed: C.down, thin: C.faint } as const)[summary.verdict] : C.faint;
  const engineLine = !run || (run.busy && !result && engine?.kind === "none" && !engine.error)
    ? { color: C.faint, text: `Running the script on ${sym}…` }
    : engine?.kind === "pine"
      ? { color: C.up, text: `Pine runtime · ${engine.scriptKind} · entries from ${engine.source} · ${engine.ms} ms` }
      : engine?.kind === "proxy"
        ? { color: C.amber, text: `The runtime could not run this script (${engine.error}). Showing the chart-manifest proxy instead.` }
        : { color: C.down, text: engine?.error ?? "" };
  const trades = result ? [...result.trades].reverse() : [];
  const shownTrades = logOpen ? trades : trades.slice(0, 8);
  const optBest = opt?.outcome?.runs[0] ?? null;
  const optBase = opt?.outcome?.baseline ?? null;
  const improved = !!(optBest && optBase && Number.isFinite(optBest.score) && optBest.score > optBase.score + 1e-9 && !optBest.values.every((v, i) => v === optBase.values[i]));
  const acceptNote = opt?.outcome && optBest ? `optimiser: ${opt.outcome.params.map((p, i) => `${p.label} ${p.value}→${optBest.values[i]}`).join(", ")} · net ${pct(optBase?.result?.netPct)}→${pct(optBest.result?.netPct)} on ${sym}` : "";

  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, fontFamily: SANS, color: C.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} onBlur={commit} aria-label="Backtest symbol" style={{ width: 90, borderRadius: 999, border: `1px solid ${C.line}`, background: C.surface, padding: "5px 10px", fontFamily: MONO, fontSize: 11, letterSpacing: ".06em", color: C.ink, textAlign: "center" }} />
        <span style={{ display: "inline-flex", gap: 2, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3 }}>
          {(["1", "5", "D", "W", "M"] as RunTf[]).map((t) => <button key={t} type="button" onClick={() => setTf(t)} title={TF_LABEL[t]} style={pill(tf === t)}>{t === "1" ? "1MIN" : t === "5" ? "5MIN" : t}</button>)}
        </span>
        <span style={sub}>{barsQ.isLoading ? "Loading bars…" : barsQ.isError || (!barsQ.isLoading && bars.length === 0) ? (isIntradayTf(tf) ? "No intraday feed for this symbol. Intraday bars cover the signals book and the top caps." : "No feed for this symbol. The scan universe is large-cap stocks.") : `${name} ${vLabel} · ${bars.length} ${TF_LABEL[tf]} bars${isIntradayTf(tf) ? ` · ${sessions} session${sessions === 1 ? "" : "s"}` : ""}`}</span>
        {intraday && tf !== "1" && <span style={chip(C.amber)}>time-of-day script</span>}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
          <span style={{ ...sub, fontSize: 12 }}>costs</span>
          <span style={{ display: "inline-flex", gap: 2, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3 }}>
            {COST_STEPS.map((b) => <button key={b} type="button" onClick={() => setCostBps(b)} title={b ? `${b} bps commission per side, ${Math.round(b / 2)} bps slippage` : "no costs"} style={pill(costBps === b)}>{b ? `${b}BP` : "0"}</button>)}
          </span>
          {sizing.declared && sizing.fraction < 1 && <span style={chip(C.faint)}>{Math.round(sizing.fraction * 100)}% of equity</span>}
        </span>
        {run?.busy && result && <span style={sub}>Sweeping and running the basket…</span>}
      </div>

      {/* the audit runs with every backtest */}
      <AuditStrip code={code} onFix={onFix} />

      {bars.length > 0 && <div style={{ ...sub, display: "flex", alignItems: "center", gap: 8 }}><span style={dot(engineLine.color)} /><span>{engineLine.text}</span></div>}

      {(noTrades || wrongTf) && bars.length > 0 && (
        <div style={{ borderRadius: 12, border: `1px solid ${C.amber}55`, background: `${C.amber}0C`, padding: "12px 14px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ ...sub, color: C.ink, fontSize: 14, flex: 1, minWidth: 260 }}>
            <strong>{wrongTf ? "Wrong bars for this script." : "No trades."}</strong>{" "}
            {wrongTf
              ? `This script decides by the clock (hour, minute or a session). On ${TF_LABEL[tf]} bars every bar reads 09:30 and the exit time never arrives, so any result here would be meaningless. Run it on intraday bars.`
              : isIntradayTf(tf)
                ? `The entry never fired in the ${sessions} session${sessions === 1 ? "" : "s"} of ${TF_LABEL[tf]} bars available.`
                : "The entry never fired on these bars. Check the entry condition, or try another symbol."}
          </span>
          {wrongTf && <button type="button" onClick={() => setTf("5")} style={secondaryBtn}>Run on intraday bars →</button>}
        </div>
      )}
      {result && summary && !noTrades && !wrongTf && (
        <>
          {/* plain-language read */}
          <div style={{ borderRadius: 10, border: `1px solid ${verdictColor}55`, background: `${verdictColor}0D`, padding: "12px 14px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: SANS, fontSize: 14, fontWeight: 700, color: verdictColor }}><span style={dot(verdictColor)} />{sentence(summary.headline)}</div>
            <p style={{ margin: "6px 0 0", fontSize: 14, lineHeight: 1.6, color: C.ink }}>{summary.text}</p>
            {isIntradayTf(tf) && sessions < 20 && <p style={{ margin: "6px 0 0", fontSize: 13, lineHeight: 1.55, color: C.muted }}>Only {sessions} session{sessions === 1 ? "" : "s"} of {TF_LABEL[tf]} bars are available, so treat this as a check that the mechanics fire, not as a backtest.</p>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 8 }}>
            {stat("NET", pct(result.netPct), result.netPct >= 0 ? C.up : C.down)}
            {stat("WIN RATE", `${result.winRate.toFixed(1)}%`)}
            {stat("PROFIT FACTOR", Number.isFinite(result.profitFactor) ? result.profitFactor.toFixed(2) : "∞")}
            {stat("MAX DRAWDOWN", `-${result.maxDdPct.toFixed(1)}%`, C.down)}
            {stat("BUY AND HOLD", pct(result.buyHoldPct), C.muted)}
          </div>
          <div style={{ borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface, padding: "10px 12px 6px" }}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="160" preserveAspectRatio="none" style={{ display: "block" }}>
              <polyline points={curve(result.bhEquity)} fill="none" stroke={C.down} strokeWidth="1.3" opacity="0.8" />
              <polyline points={curve(result.equity)} fill="none" stroke={C.up} strokeWidth="2" />
            </svg>
            <div style={{ display: "flex", gap: 14, ...label, marginTop: 4 }}><span style={{ color: C.up }}>— STRATEGY</span><span style={{ color: C.down }}>— BUY AND HOLD</span><span style={{ marginLeft: "auto" }}>{result.trades.length} TRADES · {result.signalSource.toUpperCase()}</span></div>
          </div>

          <div className="iq-q-bt" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 14 }}>
            <style>{`@media (max-width: 960px) { .iq-q-bt { grid-template-columns: 1fr !important; } }`}</style>
            <div style={{ borderRadius: 10, border: `1px solid ${C.line}`, overflow: "hidden" }}>
              <div style={{ ...label, padding: "9px 12px", borderBottom: `1px solid ${C.line}` }}>BY YEAR · BEAT BUY AND HOLD IN {result.beatYears} OF {result.yearly.length}</div>
              {result.yearly.map((y) => (
                <div key={y.year} style={{ display: "grid", gridTemplateColumns: "60px 1fr 1fr 24px", gap: 8, padding: "7px 12px", borderBottom: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: C.muted }}>{y.year}</span>
                  <span style={{ color: y.strat >= 0 ? C.up : C.down }}>{pct(y.strat)}</span>
                  <span style={{ color: C.faint }}>{pct(y.bh)}</span>
                  <span style={{ color: y.strat > y.bh ? C.up : C.faint }}>{y.strat > y.bh ? "✓" : "·"}</span>
                </div>
              ))}
            </div>
            <div style={{ borderRadius: 10, border: `1px solid ${C.line}`, padding: "9px 12px 12px" }}>
              <div style={label}>{sweep ? `PARAMETER SWEEP · ${sweep.label.toUpperCase()} ${pts[0]?.len} TO ${pts[pts.length - 1]?.len}` : engine?.kind === "pine" ? (run?.busy ? "PARAMETER SWEEP · LOOKING FOR A NUMERIC INPUT…" : "PARAMETER SWEEP · NO NUMERIC INPUT TO SWEEP") : "PARAMETER SWEEP · RUNTIME ONLY"}</div>
              {pts.length > 0 && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, pts.length)}, 1fr)`, gap: 4, marginTop: 10, alignItems: "end", height: 70 }}>
                    {pts.map((p) => { const mx = Math.max(1, ...pts.map((q) => Math.abs(q.netPct))); const h = Math.max(4, (Math.abs(p.netPct) / mx) * 64); const isBest = best && p.len === best.len; return (
                      <div key={p.len} title={`${p.len}: ${p.netPct.toFixed(1)}% · ${p.trades} trades`} style={{ height: h, borderRadius: 4, background: p.netPct >= 0 ? `rgba(8,153,129,${isBest ? 0.9 : 0.45})` : "rgba(242,54,69,.45)", border: `1px solid ${isBest ? C.up : "transparent"}` }} />
                    ); })}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", ...label, marginTop: 6 }}>{pts.map((p) => <span key={p.len}>{p.len}</span>)}</div>
                  <div style={{ marginTop: 10, fontSize: 12.5, lineHeight: 1.5, color: C.muted }}>
                    {best ? (plateau >= 3 ? `${sweep!.label} ${best.len} sits on a plateau: ${plateau} neighbouring values are also profitable. Not a fitted peak.` : `${sweep!.label} ${best.len} is the best run but its neighbours are not profitable. Treat it as fitted, trade the median.`) : ""}
                  </div>
                </>
              )}
            </div>
          </div>

          {engine?.kind === "pine" && (
            <div style={{ borderRadius: 10, border: `1px solid ${C.line}`, overflow: "hidden" }}>
              <div style={{ ...label, padding: "9px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between" }}>
                <span>ACROSS THE BOOK · THE SAME SCRIPT ON {BASKET.filter((s) => s !== sym).length} OTHER NAMES</span>
                <span>{basket.length < BASKET.filter((s) => s !== sym).length && run?.busy ? `${basket.length} DONE…` : `BEAT BUY AND HOLD ON ${basket.filter((b) => b.netPct != null && b.bhPct != null && b.netPct > b.bhPct).length} OF ${basket.length}`}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
                {basket.map((b) => (
                  <div key={b.sym} style={{ padding: "8px 12px", borderBottom: `1px solid ${C.line}`, borderRight: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 11.5, fontVariantNumeric: "tabular-nums", display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ color: C.ink }}>{b.sym}</span>
                    <span style={{ color: b.netPct == null ? C.faint : b.netPct >= 0 ? C.up : C.down }}>{pct(b.netPct)}</span>
                    <span style={{ color: C.faint }}>{pct(b.bhPct)}</span>
                    <span style={{ color: C.faint }}>{b.trades}t</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* trade log */}
          <div style={{ borderRadius: 10, border: `1px solid ${C.line}`, overflow: "hidden" }}>
            <div style={{ ...label, padding: "9px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>TRADE LOG · {result.trades.length} TRADES · NEWEST FIRST</span>
              {trades.length > 8 && <button type="button" onClick={() => setLogOpen((v) => !v)} style={pill(logOpen)}>{logOpen ? "SHOW 8" : `SHOW ALL ${trades.length}`}</button>}
            </div>
            <div style={{ overflowX: "auto" }}>
            <div style={{ minWidth: 560 }}>
            <div style={{ display: "grid", gridTemplateColumns: "44px 92px 92px 1fr 1fr 60px 70px", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${C.line}`, ...label }}>
              <span>SIDE</span><span>IN</span><span>OUT</span><span style={{ textAlign: "right" }}>ENTRY</span><span style={{ textAlign: "right" }}>EXIT</span><span style={{ textAlign: "right" }}>BARS</span><span style={{ textAlign: "right" }}>RETURN</span>
            </div>
            <div style={{ maxHeight: logOpen ? 420 : undefined, overflow: "auto" }}>
              {shownTrades.map((t, i) => (
                <div key={`${t.entryIdx}-${i}`} style={{ display: "grid", gridTemplateColumns: "44px 92px 92px 1fr 1fr 60px 70px", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                  <span style={{ color: t.side === "long" ? C.up : C.down }}>{t.side === "long" ? "LONG" : "SHORT"}</span>
                  <span style={{ color: C.muted }}>{fmtBarDate(bars[t.entryIdx])}</span>
                  <span style={{ color: C.muted }}>{fmtBarDate(bars[t.exitIdx])}</span>
                  <span style={{ color: C.ink, textAlign: "right" }}>{t.entry.toFixed(2)}</span>
                  <span style={{ color: C.ink, textAlign: "right" }}>{t.exit.toFixed(2)}</span>
                  <span style={{ color: C.faint, textAlign: "right" }}>{t.exitIdx - t.entryIdx}</span>
                  <span style={{ color: t.ret >= 0 ? C.up : C.down, textAlign: "right" }}>{pct(t.ret * 100)}</span>
                </div>
              ))}
              {trades.length === 0 && <div style={{ padding: "12px", fontSize: 13, color: C.muted }}>No trades.</div>}
            </div>
            </div>
            </div>
          </div>

          {/* optimiser */}
          {engine?.kind === "pine" && (
            <div style={{ borderRadius: 10, border: `1px solid ${C.line}`, overflow: "hidden" }}>
              <div style={{ ...label, padding: "9px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span>OPTIMISER · {params.length ? `${params.length} INPUT${params.length === 1 ? "" : "S"}: ${params.map((p) => `${p.label.toUpperCase()} (${p.value})`).join(" · ")}` : "NO NUMERIC INPUTS IN THIS SCRIPT"}</span>
                {params.length > 0 && !opt?.running && optimiserOk && <span style={{ display: "inline-flex", gap: 6 }}><button type="button" onClick={runOptimiser} style={pill(false)}>{opt?.outcome ? "RUN AGAIN" : "RUN OPTIMISER"}</button>{!wf?.running && bars.length >= 200 && <button type="button" onClick={runWalkForward} style={pill(false)}>{wf?.outcome ? "WALK-FORWARD AGAIN" : "WALK-FORWARD"}</button>}{wf?.running && <span style={label}>WALK-FORWARD {wf.done}/{wf.total}</span>}</span>}
                {params.length > 0 && !optimiserOk && <span style={sub}>needs 20+ sessions of intraday bars; {sessions} available</span>}
                {opt?.running && <span style={label}>RUNNING {opt.done}/{opt.total || "…"}</span>}
              </div>
              {opt?.error && <div style={{ padding: "10px 12px", fontSize: 13, color: C.down }}>{opt.error}</div>}
              {wf?.error && <div style={{ padding: "10px 12px", fontSize: 13, color: C.down }}>{wf.error}</div>}
              {wf?.outcome && (
                <div style={{ borderBottom: `1px solid ${C.line}` }}>
                  <div style={{ ...label, padding: "9px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                    <span>WALK-FORWARD · FIT ON THE PAST, JUDGED ON THE NEXT UNSEEN SLICE</span>
                    <span style={{ color: wf.outcome.heldUp * 2 > wf.outcome.folds.length ? C.up : C.down }}>HELD UP IN {wf.outcome.heldUp} OF {wf.outcome.folds.length}</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "56px minmax(0, 2fr) repeat(3, minmax(0, 1fr)) 60px", gap: 8, padding: "6px 12px", borderBottom: `1px solid ${C.line}`, ...label }}>
                    <span>SLICE</span><span>FITTED VALUES</span><span style={{ textAlign: "right" }}>IN SAMPLE</span><span style={{ textAlign: "right" }}>OUT OF SAMPLE</span><span style={{ textAlign: "right" }}>CURRENT OOS</span><span style={{ textAlign: "right" }}>TRADES</span>
                  </div>
                  {wf.outcome.folds.map((f) => (
                    <div key={f.fold} style={{ display: "grid", gridTemplateColumns: "56px minmax(0, 2fr) repeat(3, minmax(0, 1fr)) 60px", gap: 8, padding: "7px 12px", borderBottom: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ color: C.muted }}>{fmtBarDate(bars[f.testFrom]).slice(0, 7)}</span>
                      <span style={{ color: C.ink }}>{wf.outcome!.params.map((p, k) => `${p.label} ${f.values[k]}`).join(" · ")}</span>
                      <span style={{ textAlign: "right", color: C.faint }}>{pct(f.isNet)}</span>
                      <span style={{ textAlign: "right", color: f.oosNet != null && f.baseOosNet != null && f.oosNet > f.baseOosNet ? C.up : C.down }}>{pct(f.oosNet)}</span>
                      <span style={{ textAlign: "right", color: C.faint }}>{pct(f.baseOosNet)}</span>
                      <span style={{ textAlign: "right", color: f.oosTrades < 5 ? C.amber : C.faint }}>{f.oosTrades}</span>
                    </div>
                  ))}
                  <div style={{ padding: "8px 12px", fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>
                    {wf.outcome.heldUp * 2 > wf.outcome.folds.length
                      ? "The fitted values kept beating the current ones on data they had not seen. That is the minimum bar for trusting an optimiser result."
                      : "The fitted values did not hold up on unseen data. Whatever the optimiser finds here is likely curve-fit; keep the current values."}
                  </div>
                </div>
              )}
              {opt?.outcome && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: `minmax(0, 2fr) repeat(4, minmax(0, 1fr))`, gap: 8, padding: "6px 12px", borderBottom: `1px solid ${C.line}`, ...label }}>
                    <span>VALUES</span><span style={{ textAlign: "right" }}>NET</span><span style={{ textAlign: "right" }}>PF</span><span style={{ textAlign: "right" }}>MAX DD</span><span style={{ textAlign: "right" }}>TRADES</span>
                  </div>
                  {[opt.outcome.baseline, ...opt.outcome.runs.filter((r) => r !== opt.outcome!.baseline).slice(0, 6)].map((r: OptRun, i) => {
                    const isBase = r === opt.outcome!.baseline;
                    const isBest = r === optBest && improved;
                    return (
                      <div key={i} style={{ display: "grid", gridTemplateColumns: `minmax(0, 2fr) repeat(4, minmax(0, 1fr))`, gap: 8, padding: "7px 12px", borderBottom: `1px solid ${C.line}`, fontFamily: MONO, fontSize: 11, fontVariantNumeric: "tabular-nums", background: isBest ? "rgba(8,153,129,.08)" : "transparent" }}>
                        <span style={{ color: isBase ? C.faint : C.ink }}>{isBase ? "CURRENT · " : isBest ? "BEST · " : ""}{opt.outcome!.params.map((p, k) => `${p.label} ${r.values[k]}`).join(" · ")}</span>
                        <span style={{ textAlign: "right", color: r.result ? (r.result.netPct >= 0 ? C.up : C.down) : C.faint }}>{pct(r.result?.netPct)}</span>
                        <span style={{ textAlign: "right", color: C.ink }}>{r.result ? (Number.isFinite(r.result.profitFactor) ? r.result.profitFactor.toFixed(2) : "∞") : "—"}</span>
                        <span style={{ textAlign: "right", color: C.down }}>{r.result ? `-${r.result.maxDdPct.toFixed(1)}%` : "—"}</span>
                        <span style={{ textAlign: "right", color: r.result && r.result.trades.length < 8 ? C.amber : C.faint }}>{r.result?.trades.length ?? "—"}</span>
                      </div>
                    );
                  })}
                  <div style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, flex: 1, minWidth: 260 }}>
                      {improved
                        ? `Ranked by net return with the drawdown counted against it, at least 8 trades, ${opt.outcome.total} combinations run on ${sym} only. In-sample: accept it, then read the basket and the other years before you trust it.`
                        : `Nothing beat the current values on ${sym} across ${opt.outcome.total} combinations. Leave the inputs alone.`}
                    </span>
                    {improved && onAccept && optBest && (
                      <button type="button" onClick={() => onAccept(withParams(code, opt.outcome!.params, optBest.values), acceptNote)} style={primaryBtn}>
                        Accept as a new version →
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
      <div style={{ ...sub, fontSize: 12 }}>{engine?.kind === "proxy" ? "Chart-manifest proxy, approximate. " : "Pine runtime on the script itself. "}{sentence(TF_LABEL[tf])} bars, next-open fills, {costBps ? `${costBps} bps commission and ${Math.round(costBps / 2)} bps slippage per side` : "no costs"}{sizing.declared && sizing.fraction < 1 ? `, ${Math.round(sizing.fraction * 100)}% of equity per trade` : ""}. Exact figures in TradingView.</div>
    </div>
  );
}

/* ---------------- CODE ---------------- */
export function CodeView({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", padding: "10px 16px 0" }}>
        <button type="button" onClick={() => { navigator.clipboard?.writeText(code).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600); }); }} style={pill(copied)}>{copied ? "COPIED" : "COPY SCRIPT"}</button>
      </div>
      <pre style={{ margin: 0, padding: "12px 16px 18px", overflow: "auto", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.65, color: C.muted, whiteSpace: "pre" }}>{code}</pre>
    </div>
  );
}

/* ---------------- HISTORY ---------------- */
export function HistoryView({ script, vIdx }: { script: SavedScript; vIdx: number }) {
  const cur = script.versions[vIdx];
  const prev = vIdx > 0 ? script.versions[vIdx - 1] : null;
  const diff = prev ? diffLines(prev.code, cur.code) : null;
  return (
    <div className="iq-q-hist" style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(220px, 1fr)", fontFamily: SANS, color: C.ink }}>
      <style>{`@media (max-width: 960px) { .iq-q-hist { grid-template-columns: 1fr !important; } }`}</style>
      <pre style={{ margin: 0, padding: "14px 16px", overflow: "auto", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.65, borderRight: `1px solid ${C.line}` }}>
        {diff ? diff.map((d, i) => (
          <div key={i} style={{ display: "flex", gap: 10, background: d.k === "+" ? "rgba(8,153,129,.10)" : d.k === "-" ? "rgba(242,54,69,.10)" : "transparent", padding: "0 6px", margin: "0 -6px", borderRadius: 4, whiteSpace: "pre" }}>
            <span style={{ color: d.k === "+" ? C.up : d.k === "-" ? C.down : C.faint, width: 10 }}>{d.k}</span><span style={{ color: d.k === " " ? C.muted : C.ink, textDecoration: d.k === "-" ? "line-through" : "none" }}>{d.s}</span>
          </div>
        )) : <span style={{ color: C.faint }}>v1 · the first save, nothing to diff against.</span>}
      </pre>
      <div style={{ padding: "14px 16px", background: C.surface, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ ...label, marginBottom: 4 }}>VERSIONS</div>
        {[...script.versions].reverse().map((v) => (
          <div key={v.v} style={{ padding: "8px 10px", borderRadius: 8, fontSize: 12, color: v === cur ? C.ink : C.muted, background: v === cur ? "rgba(61,105,168,.12)" : "transparent", border: `1px solid ${v === cur ? "rgba(61,105,168,.45)" : C.line}` }}>v{v.v} · {v.note} · <span style={{ color: C.faint }}>{fmtDate(v.ts)}</span></div>
        ))}
      </div>
    </div>
  );
}

/* shared version strip: v1 v2 v3 … with the note of the selected one */
export function VersionPills({ script, vIdx, onPick }: { script: SavedScript; vIdx: number; onPick: (i: number) => void }) {
  const cur = script.versions[vIdx];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      <span style={{ display: "inline-flex", gap: 4 }}>
        {script.versions.map((v, i) => <button key={v.v} type="button" onClick={() => onPick(i)} title={`${v.note} · ${fmtDate(v.ts)}`} style={pill(i === vIdx)}>v{v.v}</button>)}
      </span>
      {cur && <span style={{ ...sub, fontSize: 12.5 }}>{cur.note} · {fmtDate(cur.ts)}</span>}
    </span>
  );
}

/* ---------------- BACKTEST PANEL (the Quant sidebar entry) ----------------
   Backtesting as a first-class door: pick a saved script and a version, or
   paste Pine, then BACKTEST or AUDIT it. Opens with the script from the open
   chat when there is one, else the latest save. The audit's fix button goes
   back to the creator chat; the optimiser's accept files a new version. */
export function BacktestPanel({ seedCode, seedScriptId, onBuild, onFix, onVersion }: {
  seedCode: string | null;
  seedScriptId?: string | null;
  onBuild: () => void;
  onFix: (ctx: FixContext) => void;
  onVersion: (script: SavedScript, version: ScriptVersion, note: string) => void;
}) {
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [source, setSource] = useState<string>("paste"); // "paste" | saved script id
  const [vIdx, setVIdx] = useState<number>(-1); // -1 = latest
  const [pasted, setPasted] = useState<string>(seedCode ?? "");
  const [tab, setTab] = useState<"backtest" | "audit">("backtest");
  const refresh = () => { const l = listScripts(); setScripts(l); return l; };
  useEffect(() => {
    const l = refresh();
    if (seedScriptId && l.some((x) => x.id === seedScriptId)) setSource(seedScriptId);
    else if (!seedCode && l.length) setSource(l[0].id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const saved = scripts.find((x) => x.id === source) ?? null;
  const vi = saved ? (vIdx >= 0 && vIdx < saved.versions.length ? vIdx : saved.versions.length - 1) : -1;
  const version = saved ? saved.versions[vi] : null;
  const code = saved ? version!.code : pasted.trim();
  const name = saved ? saved.name : code ? nameFromCode(code) : "";
  const vLabel = saved ? `v${version!.v}` : "pasted";

  const accept = (newCode: string, note: string) => {
    let s: SavedScript | null;
    if (saved) s = addVersion(saved.id, { code: newCode, render: version?.render ?? null, note });
    else { const first = saveScript({ code, render: null, note: "pasted into the backtester" }); s = addVersion(first.id, { code: newCode, render: null, note }); }
    if (!s) return;
    refresh();
    setSource(s.id);
    setVIdx(s.versions.length - 1);
    onVersion(s, latestVersion(s), note);
  };

  return (
    <div style={{ padding: "20px 20px 32px", fontFamily: SANS, color: C.ink, overflow: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-.02em" }}>Backtest</h2>
          <p style={{ ...sub, margin: "4px 0 0", fontSize: 13.5 }}>Runs the script itself on our bars, daily or 1-minute, and audits it at the same time. Fills at the next open, no costs.</p>
        </div>
        <button type="button" onClick={onBuild} style={{ ...linkBtn, marginTop: 6 }}>New script with the copilot →</button>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <select value={source} onChange={(e) => { setSource(e.target.value); setVIdx(-1); }} aria-label="Script to test" style={selectStyle}>
          <option value="paste">Paste Pine code…</option>
          {scripts.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        {saved && <VersionPills script={saved} vIdx={vi} onPick={setVIdx} />}
        <span style={{ display: "inline-flex", gap: 4, border: `1px solid ${C.line}`, borderRadius: 999, padding: 3, marginLeft: "auto" }}>
          <button type="button" onClick={() => setTab("backtest")} style={pill(tab === "backtest")}>BACKTEST</button>
          <button type="button" onClick={() => setTab("audit")} style={pill(tab === "audit")}>AUDIT</button>
        </span>
      </div>
      {!saved && (
        <textarea
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={"//@version=6\nindicator(\"My idea\", overlay=true)\n… paste any Pine v6 script. Entries come from strategy.entry/close, plotshape/plotchar, alertcondition, or plotted lines crossing."}
          spellCheck={false}
          style={{ width: "100%", minHeight: 160, resize: "vertical", borderRadius: 12, border: `1px solid ${C.line}`, background: C.surface, color: C.ink, padding: "12px 14px", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.6, marginBottom: 12, boxSizing: "border-box" }}
        />
      )}
      {code ? (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.card, overflow: "hidden" }}>
          {tab === "backtest"
            ? <BacktestView key={`${source}:${vi}`} name={name} vLabel={vLabel} code={code} render={version?.render ?? null} onFix={(findings) => onFix({ script: saved, version, code, findings })} onAccept={accept} />
            : <AuditView code={code} />}
        </div>
      ) : (
        <div style={{ border: `1px dashed ${C.line}`, borderRadius: 14, padding: "36px 24px", textAlign: "center", color: C.muted, fontSize: 14, lineHeight: 1.6 }}>
          Nothing to test yet. Paste a script above, pick a saved one, or build one with the copilot and press SAVE SCRIPT.
        </div>
      )}
    </div>
  );
}

/* ---------------- SAVED SCRIPTS (the library) ----------------
   Every script saved from the copilot, with its versions, on the same four
   views. Mounted inside the Quant desk in place of the thread. */
type Tab = "audit" | "backtest" | "code" | "history";

export function ScriptLibrary({ onBuild, onFix, onVersion }: {
  onBuild: () => void;
  onFix?: (ctx: FixContext) => void;
  onVersion?: (script: SavedScript, version: ScriptVersion, note: string) => void;
}) {
  const [scripts, setScripts] = useState<SavedScript[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [vIdx, setVIdx] = useState<number>(-1);
  const [tab, setTab] = useState<Tab>("audit");
  useEffect(() => { const l = listScripts(); setScripts(l); if (l.length && !activeId) setActiveId(l[0].id); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const active = scripts.find((s) => s.id === activeId) ?? null;
  const vi = active ? (vIdx >= 0 && vIdx < active.versions.length ? vIdx : active.versions.length - 1) : -1;
  const version = active ? active.versions[vi] : null;
  const remove = (id: string) => { deleteScript(id); const l = listScripts(); setScripts(l); setActiveId(l[0]?.id ?? null); setVIdx(-1); };
  const accept = (newCode: string, note: string) => {
    if (!active) return;
    const s = addVersion(active.id, { code: newCode, render: version?.render ?? null, note });
    if (!s) return;
    setScripts(listScripts()); setVIdx(s.versions.length - 1);
    onVersion?.(s, latestVersion(s), note);
  };
  const buildBtn = (text: string, primary: boolean) => (
    <button type="button" onClick={onBuild} style={primary
      ? { display: "inline-block", marginTop: 18, padding: "11px 20px", borderRadius: 999, background: C.steel, border: "none", color: "#fff", fontWeight: 700, fontSize: 14, cursor: "pointer", fontFamily: SANS }
      : { display: "block", width: "100%", textAlign: "left", padding: "14px", fontSize: 13.5, fontWeight: 600, color: C.steel, background: "transparent", border: "none", cursor: "pointer", fontFamily: SANS }}>{text}</button>
  );

  return (
    <div style={{ padding: "20px 20px 32px", fontFamily: SANS, color: C.ink, overflow: "auto", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: "-.02em" }}>Saved scripts</h2>
        <span style={{ ...sub, fontSize: 13.5 }}>Every version, audited and backtested.</span>
      </div>
      <div className="iq-q-grid" style={{ display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
        <style>{`@media (max-width: 960px) { .iq-q-grid { grid-template-columns: 1fr !important; } }`}</style>
        <aside style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.card, overflow: "hidden" }}>
          <div style={{ ...label, padding: "12px 14px", borderBottom: `1px solid ${C.line}` }}>{scripts.length} SCRIPT{scripts.length === 1 ? "" : "S"}</div>
          {scripts.map((s) => (
            <button key={s.id} type="button" onClick={() => { setActiveId(s.id); setVIdx(-1); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 14px", background: s.id === activeId ? "rgba(61,105,168,.08)" : "transparent", border: "none", borderLeft: `2px solid ${s.id === activeId ? C.steel : "transparent"}`, borderBottom: `1px solid ${C.line}`, cursor: "pointer", color: C.ink, fontFamily: SANS }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</div>
              <div style={{ ...label, marginTop: 4 }}>v{s.versions.length} · {fmtDate(s.ts)}{s.chatId ? " · FROM A CHAT" : ""}</div>
            </button>
          ))}
          {buildBtn("+ New script with the copilot →", false)}
        </aside>
        {!active || !version ? (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.card, padding: "44px 32px", textAlign: "center" }}>
            <div style={{ fontSize: 19, fontWeight: 700 }}>Nothing saved yet.</div>
            <p style={{ color: C.muted, fontSize: 14.5, lineHeight: 1.6, maxWidth: 480, margin: "10px auto 0" }}>Build a script with the copilot and press SAVE SCRIPT in the workbench. It lands here with its audit, its backtest and every version you save after.</p>
            {buildBtn("Open the copilot →", true)}
          </div>
        ) : (
          <div style={{ border: `1px solid ${C.line}`, borderRadius: 14, background: C.card, overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", borderBottom: `1px solid ${C.line}`, flexWrap: "wrap" }}>
              <div style={{ fontSize: 17, fontWeight: 700 }}>{active.name}</div>
              <VersionPills script={active} vIdx={vi} onPick={setVIdx} />
              <button type="button" onClick={() => remove(active.id)} style={{ ...pill(false), marginLeft: "auto", color: C.down, borderColor: "rgba(242,54,69,.35)" }}>DELETE</button>
            </div>
            <div style={{ display: "flex", gap: 4, padding: "10px 16px", borderBottom: `1px solid ${C.line}` }}>
              {(["audit", "backtest", "code", "history"] as Tab[]).map((t) => <button key={t} type="button" onClick={() => setTab(t)} style={pill(tab === t)}>{t.toUpperCase()}</button>)}
            </div>
            {tab === "audit" && <AuditView code={version.code} />}
            {tab === "backtest" && <BacktestView key={`${active.id}:${vi}`} name={active.name} vLabel={`v${version.v}`} code={version.code} render={version.render} onFix={onFix ? (findings) => onFix({ script: active, version, code: version.code, findings }) : undefined} onAccept={accept} />}
            {tab === "code" && <CodeView code={version.code} />}
            {tab === "history" && <HistoryView script={active} vIdx={vi} />}
          </div>
        )}
      </div>
    </div>
  );
}
