import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { parsePineChoices, type PineChoices } from "@/lib/pineChoices";
import { saveScript, nameFromCode, getScript, findByChat, addVersion, latestVersion, type SavedScript, type ScriptVersion } from "@/lib/scriptLibrary";
import { AuditView, BacktestView, BacktestPanel, ScriptLibrary, VersionPills, fixRequestText, type FixContext } from "@/components/quant/ScriptViews";
import { installScriptSync } from "@/lib/scriptSync";
import { LAB_LABEL } from "@/lib/labLabel";
import { createChart, LineStyle, type IChartApi, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { iqScreenerQuery, barsDailyQuery, barsWeeklyQuery, barsMonthlyQuery, iqBars1mQuery, rows1mToBars, type ScreenerRow, type ScreenerTfState, type Bar } from "@/lib/tht-api";


/* ================================================================
   IQ ANALYST — implemented to the page specification v2 (canonical).
   Two states over one frame: A "Focused start", B "Desk chat".
   The ticker is the contact; its live read is its status.
   TODO(spec): divergence detection (osc DIVERGENCE / WATCH read) — the
     scan does not emit divergence yet; reads are ALIGNED/MIXED only.
   TODO(spec): proactive messages + unread badges — needs the server-side
     watch engine; the UI hooks exist (badge rendering) but nothing emits.
   TODO(spec): "Arm alert" stores the watch locally and confirms in-thread;
     push/email delivery needs the alert pipeline.
   TODO(spec): athDistancePct / pctSinceFlip — not in the scan feed yet.
   ================================================================ */

/* ---------------- 1. DESIGN TOKENS ---------------- */
const T = {
  bg: "var(--iq-bg)",
  surface: "var(--iq-bg)",
  raised: "var(--iq-surface)",
  bubbleAi: "var(--iq-surface-deep)",
  panel: "var(--iq-surface)",
  menu: "var(--iq-surface)",
  hairline: "var(--iq-line)",
  hairlineSoft: "var(--iq-line)",
  hoverFill: "var(--iq-card)",
  inputFill: "var(--iq-card)",
  accent: "#3D69A8",
  accentLt: "var(--iq-steel)",
  accentBorder: "rgba(61,105,168,.4)",
  accentBorderSoft: "rgba(61,105,168,.3)",
  accentTint: "rgba(61,105,168,.08)",
  accentTintStrong: "rgba(61,105,168,.16)",
  focusRing: "rgba(61,105,168,.15)",
  focusBorder: "rgba(61,105,168,.5)",
  mint: "#089981",
  bear: "#F23645",
  bearSoft: "#F23645",
  amber: "#F5B841",
  neutral: "#8595B4",
  ink: "var(--iq-ink)",
  body: "var(--iq-muted)",
  muted: "var(--iq-muted)",
  faint: "var(--iq-faint)",
  ghost: "#3A4A6B",
  navGlass: "rgba(5,5,5,.72)",
  overlay: "rgba(5,5,5,.7)",
} as const;

const MONO = "'IBM Plex Mono', monospace";
const SANS = "'DM Sans', sans-serif";

const pageCss = `
  .iqa-root { -webkit-font-smoothing: antialiased; }
  .iqa-root ::selection { background: rgba(61,105,168,.4); color: #fff; }
  .iqa-root textarea, .iqa-root input { outline: none; }
  .iqa-root textarea:focus, .iqa-root input:focus {
    border-color: ${T.focusBorder} !important;
    box-shadow: 0 0 0 3px ${T.focusRing};
  }
  .iqa-root button:focus-visible, .iqa-root a:focus-visible {
    outline: 2px solid ${T.accent}; outline-offset: 2px;
  }
  .iqa-quiet-pill { transition: color .2s ease, border-color .2s ease, background .2s ease; }
  .iqa-quiet-pill:hover { border-color: ${T.accentBorder} !important; color: ${T.ink} !important; }
  .iqa-sugg:hover { border-color: rgba(61,105,168,.45) !important; color: ${T.ink} !important; }
  .iqa-row:hover { background: ${T.hoverFill}; }
  .iqa-row:hover .iqa-row-dots { opacity: 1; }
  .iqa-menu-item:hover { background: ${T.hoverFill}; }
  .iqa-primary:hover { filter: brightness(1.1); }
  .iqa-navtab { transition: color .2s ease; }
  .iqa-navtab:hover { color: ${T.ink} !important; }
  @keyframes iqaPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  @keyframes iqaTyping { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
  @keyframes iqaEnter { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .iqa-msg { animation: iqaEnter .18s ease-out; }
  .iqa-bubble-wrap .iqa-ts { opacity: 0; transition: opacity .15s ease; }
  .iqa-bubble-wrap:hover .iqa-ts { opacity: 1; }
  /* Pine workspace: the code+chart rail lives beside the chat on wide
     desks (the LuxAlgo layout); on narrow screens the rail hides and the
     script renders inline in the thread instead — never unreachable. */
  .iqa-code-inline { display: none; }
  @media (max-width: 1280px) {
    .iqa-workbench { display: none !important; }
    .iqa-code-inline { display: block; }
    /* with the rail hidden the chat takes the full width again */
    .iqa-chatcol { flex: 1 1 auto !important; width: auto !important; border-right: none !important; }
  }
  @media (prefers-reduced-motion: reduce) {
    .iqa-root * { animation: none !important; transition: none !important; }
  }
`;

/* ---------------- 7. DATA MODEL ---------------- */
type Osc = "RISING" | "FALLING" | "FLAT";
type Read = "ALIGNED" | "MIXED";
type TickerRead = {
  sym: string;
  name: string;
  price: number | null;
  bands: "BUY" | "SELL";
  daysInRegime: number | null;
  osc: Osc;
  read: Read;
  floor: number | null;
  ceiling: number | null;
  regimeLo: number | null;
  regimeHi: number | null;
  swingHi: number | null;
  swingLo: number | null;
};

type LevelRow = ScreenerRow & {
  d?: ScreenerRow["d"] & {
    close?: number | null;
    floor?: number | null;
    ceiling?: number | null;
    regime_lo?: number | null;
    regime_hi?: number | null;
    swing_hi?: number | null;
    swing_lo?: number | null;
  };
};

function deriveRead(r: LevelRow): TickerRead | null {
  const d = r.d;
  if (!d) return null;
  const bands = d.regime === "bull" ? "BUY" : "SELL";
  const osc: Osc = d.wave_rel === "above" ? "RISING" : d.wave_rel === "below" ? "FALLING" : "FLAT";
  const read: Read =
    (bands === "BUY" && osc === "RISING") || (bands === "SELL" && osc === "FALLING")
      ? "ALIGNED"
      : "MIXED";
  return {
    sym: r.sym,
    name: r.name ?? r.sym,
    price: r.price ?? d.close ?? null,
    bands,
    daysInRegime: d.age ?? null,
    osc,
    read,
    floor: d.floor ?? null,
    ceiling: d.ceiling ?? null,
    regimeLo: d.regime_lo ?? null,
    regimeHi: d.regime_hi ?? null,
    swingHi: d.swing_hi ?? null,
    swingLo: d.swing_lo ?? null,
  };
}

const readWord = (t: TickerRead) =>
  t.read === "ALIGNED" ? "aligned" : t.bands === "SELL" ? "sell regime" : "mixed";
const readColor = (t: TickerRead | null) =>
  !t ? T.neutral : t.read === "ALIGNED" && t.bands === "BUY" ? T.mint : t.bands === "SELL" ? T.bear : T.neutral;
const dotColor = (t: TickerRead | null) =>
  !t ? T.neutral : t.bands === "BUY" ? T.mint : T.bear;
const statusLine = (t: TickerRead) =>
  `${readWord(t)} — bands ${t.bands === "BUY" ? "long" : "short"} · day ${t.daysInRegime ?? "?"}, momentum ${t.osc === "RISING" ? "rising" : t.osc === "FALLING" ? "falling" : "flat"}`;
const fmtPrice = (v: number | null) => (v == null ? "—" : `$${v.toFixed(2)}`);

/* ---------------- setup snapshot (for the grounded card) ---------------- */
/* The card uses the IQ indicator brand palette (same as the Pine scripts and
   the screener chips), not the page's soft mint/salmon accents. */
const IQ_GREEN = "#089981";
const IQ_RED = "#F23645";
const IQ_AMBER = "#FFAA00";

type TfSnap = { regime: "bull" | "bear"; age: number | null; osc: Osc; flow: string | null; conf: number | null; basisPct: number | null } | null;
type SetupSnap = {
  sym: string;
  price: number | null;
  d: TfSnap;
  w: TfSnap;
  m: TfSnap;
  structEvents: string[];
  levels: { swingHi: number | null; swingLo: number | null; regimeLo: number | null; regimeHi: number | null };
};

const numOrNull = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

function tfSnap(s?: ScreenerTfState | null): TfSnap {
  if (!s) return null;
  const osc: Osc = s.wave_rel === "above" ? "RISING" : s.wave_rel === "below" ? "FALLING" : "FLAT";
  return { regime: s.regime, age: s.age, osc, flow: s.flow, conf: s.conf, basisPct: s.basis_pct };
}

function buildSetupSnap(row: ScreenerRow | undefined): SetupSnap | null {
  if (!row || !row.d) return null;
  const dd = row.d as Record<string, unknown>;
  return {
    sym: row.sym,
    price: row.price ?? numOrNull(dd.close),
    d: tfSnap(row.d),
    w: tfSnap(row.w),
    m: tfSnap(row.m),
    structEvents: Array.isArray(row.struct_events) ? row.struct_events : [],
    levels: {
      swingHi: numOrNull(dd.swing_hi) ?? numOrNull(dd.ceiling),
      swingLo: numOrNull(dd.swing_lo) ?? numOrNull(dd.floor),
      regimeLo: numOrNull(dd.regime_lo),
      regimeHi: numOrNull(dd.regime_hi),
    },
  };
}

/* Net bias across the three timeframes, weighted daily-heaviest. */
function netBias(s: SetupSnap): { label: string; color: string } {
  const score = (tf: TfSnap, w: number) => (tf ? (tf.regime === "bull" ? w : -w) : 0);
  const net = score(s.d, 3) + score(s.w, 2) + score(s.m, 1);
  const aligned = [s.d, s.w, s.m].filter(Boolean).every((t) => t!.regime === s.d?.regime);
  if (aligned && s.d) return s.d.regime === "bull" ? { label: "ALIGNED LONG", color: IQ_GREEN } : { label: "ALIGNED SHORT", color: IQ_RED };
  if (net > 0) return { label: "NET LONG", color: IQ_GREEN };
  if (net < 0) return { label: "NET SHORT", color: IQ_RED };
  return { label: "CONFLICTED", color: IQ_AMBER };
}

/* Pull the qualitative sentence(s) out of the model's answer; the numeric
   bullets are now shown by the card, so we keep only the interpretation. */
function setupNote(text: string): string {
  const idx = text.search(/bottom line\s*:/i);
  if (idx >= 0) return text.slice(idx).replace(/^bottom line\s*:\s*/i, "").trim();
  const prose = text
    .split("\n")
    .filter((l) => l.trim() && !/^\s*[-•]/.test(l))
    .join("\n")
    .trim();
  return prose || text.trim();
}

/* Does a chart answer read like a full setup (so it earns the visual card)? */
function isSetupText(t: string): boolean {
  return /(^|\n)\s*[-•]?\s*daily\s*:/i.test(t) && /(weekly|monthly|structure|bottom line)/i.test(t);
}

function scanClock(iso: string | undefined): string {
  if (!iso) return "—:—";
  const d = new Date(iso);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------- persistence (localStorage) ---------------- */
type Assistant = "chart" | "pine" | "coach";
type BrainSpec = {
  name: string;
  oneLiner: string;
  category: string;
  problem: string;
  logic: string[];
  inputs: { label: string; default: string }[];
  signals: string[];
  alerts: string[];
  iqHook: { source: string; use: string } | null;
  twist: string;
  render: WbRender | null;
  chips: string[];
};
type Msg = { role: "user" | "ai"; text: string; ts: number; chips?: string[]; sub?: string; label?: boolean; kind?: "setup" | "spec"; setup?: SetupSnap; spec?: BrainSpec };
type Chat = {
  id: string;
  assistant: Assistant;
  sym: string | null;
  title: string;
  snippet: string;
  ts: number;
  pinned?: boolean;
  armed?: boolean;
  /* the saved script this chat builds (set on the first save; new copilot
     replies are filed as versions of it) */
  scriptId?: string;
  scanTag: string;
  messages: Msg[];
};

const LS_CHATS = "iqa.chats.v1";
const LS_TICKER = "iqa.lastTicker.v1";

function loadChats(): Chat[] {
  try {
    const raw = localStorage.getItem(LS_CHATS);
    const v = raw ? (JSON.parse(raw) as Chat[]) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function saveChats(c: Chat[]) {
  try {
    localStorage.setItem(LS_CHATS, JSON.stringify(c.slice(0, 80)));
  } catch {
    /* storage full — chat history simply won't persist */
  }
}

function ageLabel(ts: number): string {
  const h = Math.floor((Date.now() - ts) / 3_600_000);
  if (h < 1) return "NOW";
  if (h < 24) return `${h}H`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}D`;
  return `${Math.floor(d / 7)}W`;
}

/* ---------------- shared atoms ---------------- */
function SendCircle({ size, disabled, hero, onClick }: { size: number; disabled: boolean; hero?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Send message"
      onClick={onClick}
      disabled={disabled}
      className={disabled ? undefined : "iqa-primary"}
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: "none",
        background: T.accent,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        boxShadow: disabled ? "none" : hero ? "0 10px 26px rgba(61,105,168,.4)" : "0 8px 22px rgba(61,105,168,.35)",
        flexShrink: 0,
      }}
    >
      <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 19V5m-7 7 7-7 7 7" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function QuietPill({ children, solid, onClick }: { children: React.ReactNode; solid?: boolean; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={solid ? "iqa-primary" : "iqa-quiet-pill"}
      style={{
        borderRadius: 999,
        padding: "7px 14px",
        fontSize: 12.5,
        fontFamily: SANS,
        cursor: "pointer",
        ...(solid
          ? { background: T.accent, color: "#fff", fontWeight: 700, border: "none", boxShadow: "0 8px 22px rgba(61,105,168,.35)" }
          : { background: "transparent", color: T.muted, border: `1px solid ${T.hairline}` }),
      }}
    >
      {children}
    </button>
  );
}

function Avatar({ sym, read, size = 38, glyph }: { sym?: string; read?: TickerRead | null; size?: number; glyph?: string }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
      <span
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: T.accentTint,
          border: `1px solid ${T.accentBorder}`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: MONO,
          fontSize: 11,
          fontWeight: 600,
          color: T.accentLt,
        }}
      >
        {glyph ?? (sym ?? "").slice(0, 2)}
      </span>
      {read !== undefined && !glyph && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: dotColor(read ?? null),
            border: `2px solid ${T.bg}`,
          }}
        />
      )}
    </span>
  );
}

/* ---------------- 5. Ticker picker ---------------- */
function TickerPicker({
  reads,
  recents,
  onPick,
  onClose,
  anchor,
}: {
  reads: Map<string, TickerRead>;
  recents: string[];
  onPick: (sym: string) => void;
  onClose: () => void;
  anchor: "chip" | "center";
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const all = useMemo(() => Array.from(reads.values()), [reads]);
  const results = useMemo(() => {
    const query = q.trim().toUpperCase();
    if (!query) return [];
    return all
      .filter((t) => t.sym.includes(query) || t.name.toUpperCase().includes(query))
      .slice(0, 8);
  }, [q, all]);
  const aligned = useMemo(() => all.filter((t) => t.read === "ALIGNED" && t.bands === "BUY"), [all]);
  const recentReads = recents.map((s) => reads.get(s)).filter(Boolean) as TickerRead[];
  const flat = q.trim() ? results : [...recentReads, ...aligned];

  useEffect(() => setIdx(0), [q]);

  const row = (t: TickerRead, i: number) => (
    <button
      key={t.sym}
      type="button"
      onClick={() => onPick(t.sym)}
      className="iqa-menu-item"
      style={{
        width: "100%",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 14px",
        background: i === idx ? T.hoverFill : "transparent",
        border: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
        <span style={{ fontFamily: MONO, fontSize: 12, fontWeight: 600, color: T.accentLt }}>{t.sym}</span>
        <span style={{ fontFamily: SANS, fontSize: 12.5, color: T.muted, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.name}
        </span>
      </span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor(t) }} />
        <span style={{ fontFamily: MONO, fontSize: 10, color: readColor(t) }}>
          {t.read === "ALIGNED" ? "ALIGNED" : t.bands === "SELL" ? "SELL" : "MIXED"}
        </span>
      </span>
    </button>
  );

  const groupLabel = (label: string) => (
    <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.16em", color: T.ghost, padding: "10px 14px 4px" }}>{label}</div>
  );

  return (
    <div
      role="dialog"
      aria-label="Pick a ticker"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, flat.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
        else if (e.key === "Enter" && flat[idx]) { e.preventDefault(); onPick(flat[idx].sym); }
      }}
      style={{
        position: anchor === "chip" ? "absolute" : "fixed",
        ...(anchor === "chip" ? { top: "calc(100% + 8px)", left: 0 } : { top: "50%", left: "50%", transform: "translate(-50%,-50%)" }),
        width: 320,
        background: T.panel,
        border: `1px solid ${T.hairline}`,
        borderRadius: 14,
        boxShadow: "0 24px 60px rgba(0,0,0,.55)",
        zIndex: 60,
        overflow: "hidden",
      }}
    >
      <div style={{ padding: 10 }}>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search"
          style={{
            width: "100%",
            border: `1px solid ${T.hairline}`,
            background: T.inputFill,
            borderRadius: 10,
            padding: "10px 14px",
            fontFamily: SANS,
            fontSize: 13,
            color: T.ink,
          }}
        />
      </div>
      <div style={{ maxHeight: 8 * 41, overflowY: "auto" }}>
        {q.trim() ? (
          results.length ? results.map(row) : (
            <div style={{ padding: "18px 14px", textAlign: "center" }}>
              <div style={{ fontFamily: MONO, fontSize: 10, color: T.faint }}>NO MATCHES</div>
              <div style={{ fontFamily: SANS, fontSize: 12.5, color: T.muted, marginTop: 6 }}>Try a different symbol or word.</div>
            </div>
          )
        ) : (
          <>
            {recentReads.length > 0 && groupLabel("RECENT")}
            {recentReads.map((t, i) => row(t, i))}
            {aligned.length > 0 && groupLabel("ALIGNED TODAY")}
            {aligned.map((t, i) => row(t, recentReads.length + i))}
          </>
        )}
      </div>
      <div style={{ borderTop: `1px solid ${T.hairline}`, padding: "7px 14px", fontFamily: MONO, fontSize: 9, letterSpacing: "0.08em", color: T.ghost }}>
        ↑↓ NAVIGATE · ⏎ SELECT · ESC CLOSE
      </div>
    </div>
  );
}

let TICKER_COUNT_LABEL = "—";

/* ---------------- 2.2 Sidebar ---------------- */
const ASSISTANTS: { key: Assistant; glyph: string; name: string; mono?: boolean }[] = [
  { key: "chart", glyph: "◈", name: "Analyse a chart" },
  { key: "pine", glyph: "</>", name: "Pine Copilot", mono: true },
  { key: "coach", glyph: "◎", name: "Trading Coach" },
];

function Sidebar({
  chats,
  assistants,
  extra,
  activeId,
  assistant,
  reads,
  credits,
  onNew,
  onOpen,
  onSwitchAssistant,
  onDelete,
  onPin,
  onRename,
  onClear,
}: {
  chats: Chat[];
  assistants: typeof ASSISTANTS;
  extra: { glyph: string; name: string; active: boolean; onClick: () => void }[];
  activeId: string | null;
  assistant: Assistant;
  reads: Map<string, TickerRead>;
  credits: { left: number; total: number } | null;
  onNew: () => void;
  onOpen: (id: string) => void;
  onSwitchAssistant: (a: Assistant) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameVal, setRenameVal] = useState("");

  useEffect(() => {
    const close = () => setMenuFor(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? chats.filter((c) => (c.sym ?? c.assistant).toLowerCase().includes(q) || c.snippet.toLowerCase().includes(q) || c.title.toLowerCase().includes(q))
      : chats;
    const now = Date.now();
    const day = 86_400_000;
    const groups: { label: string; items: Chat[] }[] = [
      { label: "TODAY", items: [] },
      { label: "THIS WEEK", items: [] },
      { label: "EARLIER", items: [] },
    ];
    for (const c of list) {
      const age = now - c.ts;
      (age < day ? groups[0] : age < 7 * day ? groups[1] : groups[2]).items.push(c);
    }
    for (const g of groups) g.items.sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.ts - a.ts);
    return groups.filter((g) => g.items.length > 0);
  }, [chats, search]);

  const tagFor = (c: Chat) => (c.assistant === "chart" ? c.sym ?? "?" : c.assistant === "pine" ? "PINE" : "COACH");

  const creditPct = credits ? Math.max(0, Math.min(100, (credits.left / credits.total) * 100)) : 100;
  const barColor = !credits ? T.accent : credits.left === 0 ? T.bear : credits.left <= 20 ? T.amber : T.accent;

  return (
    <aside
      style={{
        width: 300,
        flexShrink: 0,
        background: T.surface,
        borderRight: `1px solid ${T.hairline}`,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
      className="hidden lg:flex"
    >
      {/* Zone 1 */}
      <div style={{ padding: "16px 14px 0" }}>
        <button
          type="button"
          onClick={onNew}
          title="New chat ⌘N"
          className="iqa-primary"
          style={{
            width: "100%",
            background: T.accent,
            color: "#fff",
            border: "none",
            borderRadius: 11,
            padding: 11,
            fontFamily: SANS,
            fontSize: 13.5,
            fontWeight: 700,
            cursor: "pointer",
            boxShadow: "0 8px 22px rgba(61,105,168,.35)",
          }}
        >
          + New chat
        </button>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search chats…"
          style={{
            marginTop: 12,
            width: "100%",
            border: `1px solid ${T.hairline}`,
            background: T.inputFill,
            borderRadius: 10,
            padding: "10px 14px",
            fontFamily: SANS,
            fontSize: 13,
            color: T.ink,
          }}
        />
        <div style={{ marginTop: 16, display: "flex", flexDirection: "column" }}>
          {assistants.map((a) => {
            const active = assistant === a.key && !extra.some((x) => x.active);
            return (
              <button
                key={a.key}
                type="button"
                onClick={() => onSwitchAssistant(a.key)}
                className={active ? undefined : "iqa-row"}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  borderRadius: 9,
                  padding: "9px 10px",
                  cursor: "pointer",
                  background: active ? T.accentTint : "transparent",
                  border: active ? `1px solid ${T.accentBorderSoft}` : "1px solid transparent",
                  textAlign: "left",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 16,
                    textAlign: "center",
                    fontFamily: a.mono ? MONO : SANS,
                    fontSize: a.mono ? 10 : 13,
                    color: active ? T.accentLt : T.faint,
                  }}
                >
                  {a.glyph}
                </span>
                <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: active ? 600 : 400, color: active ? T.ink : T.muted }}>
                  {a.name}
                </span>
              </button>
            );
          })}
          {extra.map((x) => (
            <button key={x.name} type="button" onClick={x.onClick} className={x.active ? undefined : "iqa-row"} style={{ display: "flex", alignItems: "center", gap: 10, borderRadius: 9, padding: "9px 10px", cursor: "pointer", background: x.active ? T.accentTint : "transparent", border: x.active ? `1px solid ${T.accentBorderSoft}` : "1px solid transparent", textAlign: "left" }}>
              <span aria-hidden="true" style={{ width: 16, textAlign: "center", fontFamily: SANS, fontSize: 13, color: x.active ? T.accentLt : T.faint }}>{x.glyph}</span>
              <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: x.active ? 600 : 400, color: x.active ? T.ink : T.muted }}>{x.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Zone 2 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "4px 14px 14px", borderTop: `1px solid ${T.hairlineSoft}`, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: "14px 10px 10px" }}>
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.18em", color: T.faint }}>CHATS</span>
          {chats.length > 0 && (
            <button type="button" onClick={onClear} style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.1em", color: T.accentLt, background: "none", border: "none", cursor: "pointer" }}>
              CLEAR
            </button>
          )}
        </div>
        {chats.length === 0 && !search.trim() && (
          <div style={{ textAlign: "center", padding: "48px 10px" }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: T.faint }}>NO CHATS YET</div>
            <div style={{ fontFamily: SANS, fontSize: 12.5, color: T.muted, marginTop: 6 }}>Ask your first question and it'll live here.</div>
          </div>
        )}
        {chats.length > 0 && filtered.length === 0 && (
          <div style={{ textAlign: "center", padding: "36px 10px" }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: T.faint }}>NO MATCHES</div>
            <div style={{ fontFamily: SANS, fontSize: 12.5, color: T.muted, marginTop: 6 }}>Try a different symbol or word.</div>
          </div>
        )}
        {filtered.map((g) => (
          <div key={g.label}>
            <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.16em", color: T.ghost, padding: "10px 10px 4px" }}>{g.label}</div>
            {g.items.map((c) => {
              const active = c.id === activeId;
              const read = c.sym ? reads.get(c.sym) ?? null : undefined;
              return (
                <div
                  key={c.id}
                  className="iqa-row"
                  onClick={() => (renaming === c.id ? undefined : onOpen(c.id))}
                  style={{
                    position: "relative",
                    borderRadius: 9,
                    padding: active ? "9px 10px 9px 8px" : "9px 10px",
                    cursor: "pointer",
                    background: active ? "rgba(61,105,168,.07)" : undefined,
                    borderLeft: active ? `2px solid ${T.accent}` : "2px solid transparent",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontFamily: MONO, fontSize: 11.5, fontWeight: 600, color: T.accentLt, display: "inline-flex", gap: 5, alignItems: "baseline", minWidth: 0 }}>
                      {c.pinned && <span style={{ fontSize: 9 }}>◆</span>}
                      {renaming === c.id ? (
                        <input
                          autoFocus
                          value={renameVal}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { onRename(c.id, renameVal.trim() || c.title); setRenaming(null); }
                            if (e.key === "Escape") setRenaming(null);
                          }}
                          style={{ background: T.inputFill, border: `1px solid ${T.hairline}`, borderRadius: 6, color: T.ink, fontFamily: MONO, fontSize: 11.5, padding: "2px 6px", width: 130 }}
                        />
                      ) : (
                        tagFor(c)
                      )}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <button
                        type="button"
                        aria-label="Chat options"
                        className="iqa-row-dots"
                        onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}
                        style={{ opacity: 0, transition: "opacity .2s", background: "none", border: "none", color: T.faint, fontFamily: MONO, cursor: "pointer", padding: 0 }}
                      >
                        ⋯
                      </button>
                      <span style={{ fontFamily: MONO, fontSize: 9.5, color: T.ghost }}>{ageLabel(c.ts)}</span>
                    </span>
                  </div>
                  <div style={{ marginTop: 2, display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                    {read !== undefined && (
                      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor(read), flexShrink: 0 }} />
                    )}
                    <span style={{ fontFamily: SANS, fontSize: 12.5, color: active ? "var(--iq-muted)" : T.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {c.snippet}
                    </span>
                  </div>
                  {menuFor === c.id && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{ position: "absolute", right: 8, top: 30, background: T.menu, border: `1px solid ${T.hairline}`, borderRadius: 12, boxShadow: "0 24px 60px rgba(0,0,0,.55)", zIndex: 60, minWidth: 130, overflow: "hidden" }}
                    >
                      {(
                        [
                          ["Rename", () => { setRenaming(c.id); setRenameVal(c.title); setMenuFor(null); }],
                          [c.pinned ? "Unpin" : "Pin", () => { onPin(c.id); setMenuFor(null); }],
                          ["Delete", () => { onDelete(c.id); setMenuFor(null); }],
                        ] as const
                      ).map(([label, fn]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={fn}
                          className="iqa-menu-item"
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", fontFamily: SANS, fontSize: 13.5, color: label === "Delete" ? T.bear : T.ink, background: "none", border: "none", cursor: "pointer" }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Zone 3 */}
      <div style={{ borderTop: `1px solid ${T.hairline}`, padding: "14px 24px", flexShrink: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: "0.16em", color: T.faint }}>AI CREDITS</span>
          <span style={{ fontFamily: MONO, fontSize: 12.5 }}>
            <span style={{ fontWeight: 600, color: T.ink }}>{credits ? credits.left : "—"}</span>
            <span style={{ color: T.faint }}>/{credits ? credits.total : "—"}</span>
          </span>
        </div>
        <div style={{ marginTop: 8, height: 3, borderRadius: 2, background: "var(--iq-line)", overflow: "hidden" }}>
          <div style={{ width: `${creditPct}%`, height: "100%", background: barColor }} />
        </div>
        <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: SANS, fontSize: 11, color: T.faint }}>Resets daily</span>
          <Link to="/topup" style={{ fontFamily: SANS, fontSize: 11, fontWeight: 600, color: T.accentLt, textDecoration: "none" }}>
            Top up
          </Link>
        </div>
      </div>
    </aside>
  );
}


/* ---------------- assistant copy (§3, §8) ---------------- */
const ASSISTANT_COPY: Record<Assistant, { headline: string; subline: (scan: string, count: string) => string; placeholder: string; pills: string[]; needsTicker: boolean }> = {
  chart: {
    headline: "Which setup are we reading?",
    subline: () => "",
    placeholder: "Ask about any ticker's setup…",
    pills: ["What's the setup right now?", "Key levels to watch", "Is momentum confirming?", "What breaks this setup?"],
    needsTicker: true,
  },
  pine: {
    headline: "What are we building?",
    subline: () => "Indicators, alerts and strategy conditions — designed with you, written in Pine v6.",
    placeholder: "Describe the indicator or alert…",
    pills: ["Build me a new indicator", "Alert on band flip + rising osc", "Port my strategy to Pine v6", "Why does my script repaint?"],
    needsTicker: false,
  },
  coach: {
    headline: "What are we working on?",
    subline: () => "Habits, execution, and the trades you keep repeating — reviewed without judgment.",
    placeholder: "Describe the habit or the trade…",
    pills: ["I exit winners too early", "Review last week's trades", "Build me a pre-trade checklist", "I revenge-trade after losses"],
    needsTicker: false,
  },
};

/* ---------------- ask() wiring ---------------- */
async function askServer(body: Record<string, unknown>): Promise<{ answer: string; followups?: string[] }> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error("no_session");
  const { data, error } = await supabase.functions.invoke("ask", {
    body,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error || !data?.answer) throw error ?? new Error("no_answer");
  const clean = (data.answer as string).replace(/\s*FOLLOWUPS?\s*:[^\n]*/gi, "").trimEnd();
  return { answer: clean, followups: data.followups };
}

type BrainQuestion = { kind: "question"; step: number; question: string; options: { key: string; label: string }[]; multi?: boolean };
type BrainResult = BrainQuestion | { kind: "spec"; spec: Omit<BrainSpec, "chips" | "render"> & { render?: unknown }; chips?: string[] };

async function askStructured(body: Record<string, unknown>): Promise<BrainResult> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error("no_session");
  const { data, error } = await supabase.functions.invoke("ask", { body, headers: { Authorization: `Bearer ${token}` } });
  if (error) throw error;
  if (data?.error) throw new Error(String(data.error));
  if (!data?.result?.kind) throw new Error("no_result");
  return data.result as BrainResult;
}

function toSpec(r: Extract<BrainResult, { kind: "spec" }>): BrainSpec {
  const s = r.spec;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 8) : []);
  const inputs = Array.isArray(s.inputs)
    ? s.inputs.map((i) => ({ label: str((i as { label?: unknown })?.label), default: String((i as { default?: unknown })?.default ?? "") })).filter((i) => i.label).slice(0, 8)
    : [];
  const hook = s.iqHook && typeof s.iqHook === "object" && str((s.iqHook as { source?: unknown }).source)
    ? { source: str((s.iqHook as { source?: unknown }).source), use: str((s.iqHook as { use?: unknown }).use) }
    : null;
  let render: WbRender | null = null;
  if (s.render && typeof s.render === "object") {
    try { render = parseRender(JSON.stringify(s.render)); } catch { render = null; }
  }
  const chips = list(r.chips);
  if (!chips.length || !/build/i.test(chips[0])) chips.unshift("Build it in Pine v6");
  return { name: str(s.name) || "Untitled tool", oneLiner: str(s.oneLiner), category: str(s.category), problem: str(s.problem), logic: list(s.logic), inputs, signals: list(s.signals), alerts: list(s.alerts), iqHook: hook, twist: str(s.twist), render, chips: chips.slice(0, 4) };
}

function specToBuildPrompt(s: BrainSpec): string {
  const { chips: _c, ...rest } = s;
  return "SPEC: " + JSON.stringify(rest);
}

function specToText(s: BrainSpec): string {
  return [
    `${s.name} — ${s.oneLiner}`,
    s.logic.length ? "Logic: " + s.logic.map((l, i) => `${i + 1}. ${l}`).join(" ") : "",
    s.inputs.length ? "Inputs: " + s.inputs.map((i) => `${i.label} (${i.default})`).join(", ") : "",
    s.iqHook ? `IQ hook: ${s.iqHook.source} — ${s.iqHook.use}` : "",
  ].filter(Boolean).join("\n");
}

function fileToDataUrl(file: File, maxSide = 1280): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); reject(new Error("canvas")); return; }
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
    img.src = url;
  });
}

async function fetchCredits(): Promise<{ left: number; total: number } | null> {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return null;
    const { data } = await supabase.functions.invoke("ask", {
      body: { mode: "usage" },
      headers: { Authorization: `Bearer ${token}` },
    });
    const u = (data as { usage?: { asks_today?: number; cap?: number; purchased?: number } } | null)?.usage;
    if (u && typeof u.asks_today === "number" && typeof u.cap === "number") {
      const purchased = typeof u.purchased === "number" ? u.purchased : 0;
      return { left: Math.max(0, u.cap - u.asks_today) + purchased, total: u.cap + purchased };
    }
    return null;
  } catch {
    return null;
  }
}

/* ---------------- toasts ---------------- */
type Toast = { id: number; dot: string; text: string; sub?: string };

function Toasts({ items }: { items: Toast[] }) {
  return (
    <div style={{ position: "fixed", right: 20, bottom: 20, display: "flex", flexDirection: "column", gap: 10, zIndex: 70 }}>
      {items.map((t) => (
        <div
          key={t.id}
          className="iqa-msg"
          style={{
            background: T.menu,
            backdropFilter: "blur(12px)",
            border: `1px solid ${T.hairline}`,
            borderRadius: 12,
            padding: "14px 16px",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: t.dot, flexShrink: 0 }} />
          <span>
            <span style={{ fontFamily: SANS, fontSize: 14, color: T.ink }}>{t.text}</span>
            {t.sub && <span style={{ display: "block", fontFamily: MONO, fontSize: 12, color: T.faint, marginTop: 2 }}>{t.sub}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ---------------- confirm modal ---------------- */
function ConfirmModal({ title, action, onCancel, onConfirm }: { title: string; action: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center", background: T.overlay, backdropFilter: "blur(8px)" }}>
      <div style={{ background: T.menu, borderRadius: 20, border: `1px solid ${T.hairline}`, maxWidth: 400, width: "calc(100% - 48px)", padding: 26 }}>
        <div style={{ fontFamily: SANS, fontSize: 18, fontWeight: 700, color: T.ink }}>{title}</div>
        <p style={{ fontFamily: SANS, fontSize: 14, color: T.muted, marginTop: 10 }}>This can't be undone.</p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 22 }}>
          <QuietPill onClick={onCancel}>Cancel</QuietPill>
          <button
            type="button"
            onClick={onConfirm}
            style={{ borderRadius: 999, padding: "7px 14px", fontSize: 12.5, fontFamily: SANS, cursor: "pointer", background: "transparent", color: T.bear, border: "1px solid rgba(242,54,69,.4)" }}
          >
            {action}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- bubbles (§4.2) ---------------- */
function fmtBubbleTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* Semantic bolding: $-levels render bold; the engine's own colors carry the
   meaning in text, so levels are tinted by simple sign heuristics client-side
   is NOT possible honestly — levels render bold ink. */
function BubbleText({ text }: { text: string }) {
  const parts = text.split(/(\$\d[\d,.]*)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^\$\d/.test(p) ? (
          <strong key={i} style={{ color: T.ink, fontWeight: 600 }}>{p}</strong>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function AiBubble({ m, tag }: { m: Msg; tag?: string }) {
  return (
    <div className="iqa-msg iqa-bubble-wrap" style={{ display: "flex", alignItems: "flex-end", gap: 8, maxWidth: "min(560px, 85%)", alignSelf: "flex-start" }}>
      <div>
        {m.label && (
          <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.accentLt, marginBottom: 7 }}>
            {tag ?? "IQ ANALYST · GROUNDED"}
          </div>
        )}
        <div
          style={{
            background: T.bubbleAi,
            border: `1px solid ${T.hairlineSoft}`,
            borderRadius: "16px 16px 16px 4px",
            padding: "12px 16px",
            fontFamily: SANS,
            fontSize: 14,
            lineHeight: 1.6,
            color: T.body,
            whiteSpace: "pre-line",
          }}
        >
          <BubbleText text={m.text} />
          {m.sub && (
            <div style={{ fontFamily: MONO, fontSize: 10, color: T.faint, marginTop: 6 }}>{m.sub}</div>
          )}
          {m.chips && m.chips.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
              {m.chips.map((c) => (
                <span key={c} style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.08em", color: T.faint, border: `1px solid ${T.hairline}`, borderRadius: 999, padding: "4px 10px" }}>
                  {c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <span className="iqa-ts" style={{ fontFamily: MONO, fontSize: 9.5, color: T.ghost, flexShrink: 0, paddingBottom: 4 }}>
        {fmtBubbleTime(m.ts)}
      </span>
    </div>
  );
}

/* Choice cards: the copilot's Phase 1 menu becomes lettered options
   (A, B, C...) plus "My own idea", its Phase 2 parameter sheet becomes a
   checklist with defaults and a one-click build. Only the latest turn is
   live; older turns keep the cards but inert. */
function PineChoiceBubble({ m, choices, live, onPick, onOther }: { m: Msg; choices: Exclude<PineChoices, null>; live: boolean; onPick: (q: string) => void; onOther: () => void }) {
  const lead = choices.lead || (choices.kind === "menu" ? "Pick a direction." : "Set the rules.");
  const rowBase: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.hairlineSoft}`, background: "rgba(255,255,255,.02)", textAlign: "left", width: "100%", color: T.ink, fontFamily: SANS, fontSize: 14, cursor: live ? "pointer" : "default", opacity: live ? 1 : 0.6, transition: "border-color .15s, background .15s" };
  const badge = (label: string, on = false): React.CSSProperties => ({ width: 22, height: 22, borderRadius: 6, border: `1px solid ${on ? T.accent : T.hairline}`, background: on ? T.accent : "transparent", color: on ? "#fff" : T.muted, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 11, flex: "0 0 auto", ...(label.length > 1 ? {} : {}) });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: "min(560px, 85%)", alignSelf: "flex-start" }}>
      <AiBubble m={{ ...m, text: lead }} tag="IQ PINE COPILOT" />
      <style>{`.iqa-choice:hover { border-color: rgba(61,105,168,.6) !important; background: rgba(61,105,168,.12) !important; }`}</style>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 2 }}>
        {choices.kind === "menu" && (
          <>
            {choices.options.map((o, i) => (
              <button key={o} type="button" className={live ? "iqa-choice" : undefined} disabled={!live} onClick={() => onPick(o)} style={rowBase}>
                <span style={badge(String.fromCharCode(65 + i))}>{String.fromCharCode(65 + i)}</span>
                <span>{o}</span>
              </button>
            ))}
            <button type="button" className={live ? "iqa-choice" : undefined} disabled={!live} onClick={onOther} style={{ ...rowBase, color: T.faint }}>
              <span style={badge(String.fromCharCode(65 + choices.options.length))}>{String.fromCharCode(65 + choices.options.length)}</span>
              <span>My own idea…</span>
            </button>
          </>
        )}
        {choices.kind === "spec" && (
          <>
            {choices.params.map((pm, i) => (
              <div key={pm.label + i} style={{ ...rowBase, cursor: "default", opacity: 1, justifyContent: "space-between" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <span style={badge(String(i + 1))}>{i + 1}</span>
                  <span>{pm.label}</span>
                </span>
                {pm.def && <span style={{ fontFamily: MONO, fontSize: 11, color: T.accentLt, whiteSpace: "nowrap" }}>{pm.def}</span>}
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 4 }}>
              <button type="button" disabled={!live} onClick={() => onPick("Defaults are fine, build it")} style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: "#fff", background: T.accent, border: "none", borderRadius: 999, padding: "10px 16px", cursor: live ? "pointer" : "default", opacity: live ? 1 : 0.6 }}>
                Build with defaults ↵
              </button>
              <span style={{ fontFamily: SANS, fontSize: 13, color: T.faint }}>or type the numbers you want changed</span>
            </div>
          </>
        )}
        {choices.tail && <div style={{ fontFamily: SANS, fontSize: 13, color: T.faint, marginTop: 2 }}>{choices.tail}</div>}
      </div>
    </div>
  );
}

function UserBubble({ m }: { m: Msg }) {
  return (
    <div className="iqa-msg iqa-bubble-wrap" style={{ display: "flex", alignItems: "flex-end", gap: 8, maxWidth: "min(560px, 85%)", alignSelf: "flex-end" }}>
      <span className="iqa-ts" style={{ fontFamily: MONO, fontSize: 9.5, color: T.ghost, flexShrink: 0, paddingBottom: 4 }}>
        {fmtBubbleTime(m.ts)}
      </span>
      <div style={{ background: T.accent, borderRadius: "16px 16px 4px 16px", padding: "12px 16px", fontFamily: SANS, fontSize: 14, lineHeight: 1.55, color: "#fff" }}>
        {m.text}
      </div>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div style={{ textAlign: "center", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.ghost, margin: "4px 0" }}>
      {label}
    </div>
  );
}

function TypingBubble() {
  return (
    <div aria-label="IQ Analyst is typing" style={{ alignSelf: "flex-start", background: T.bubbleAi, border: `1px solid ${T.hairlineSoft}`, borderRadius: "16px 16px 16px 4px", padding: "14px 18px", display: "inline-flex", gap: 5 }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: T.faint, animation: `iqaTyping 1.2s ease-in-out ${i * 0.2}s infinite` }} />
      ))}
    </div>
  );
}

/* ---------------- Brainstorm: spec card + guided panel ----------------
   The Brainstorm walks three short questions and lands a build-ready spec;
   the spec renders as a card in the thread whose first chip hands the whole
   spec to the Pine Copilot as a one-shot build. */
function SpecCard({ m, onChip, busy }: { m: Msg; onChip: (chip: string) => void; busy: boolean }) {
  const s = m.spec;
  if (!s) return null;
  const head = (t: string) => (
    <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.faint, margin: "12px 0 6px" }}>{t}</div>
  );
  return (
    <div className="iqa-msg iqa-bubble-wrap" style={{ display: "flex", alignItems: "flex-end", gap: 8, maxWidth: "min(560px, 92%)", alignSelf: "flex-start" }}>
      <div style={{ width: "100%" }}>
        <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.accentLt, marginBottom: 7 }}>
          IQ PINE COPILOT · SPEC
        </div>
        <div
          style={{
            background: T.bubbleAi,
            border: `1px solid ${T.hairlineSoft}`,
            borderRadius: "16px 16px 16px 4px",
            padding: "14px 16px",
            fontFamily: SANS,
            fontSize: 13.5,
            lineHeight: 1.6,
            color: T.body,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15.5, fontWeight: 700, color: T.ink }}>{s.name}</span>
            {s.category && (
              <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.08em", color: T.accentLt, border: `1px solid ${T.accentBorderSoft}`, background: T.accentTint, borderRadius: 999, padding: "3px 9px" }}>
                {s.category.toUpperCase()}
              </span>
            )}
          </div>
          {s.oneLiner && <div style={{ marginTop: 5 }}>{s.oneLiner}</div>}
          {s.problem && <div style={{ marginTop: 6, color: T.muted }}>{s.problem}</div>}

          {s.logic.length > 0 && (
            <>
              {head("LOGIC")}
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                {s.logic.map((l, i) => <li key={i}>{l}</li>)}
              </ol>
            </>
          )}

          {s.inputs.length > 0 && (
            <>
              {head("INPUTS · DEFAULTS")}
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 12px" }}>
                {s.inputs.map((i, k) => (
                  <div key={k} style={{ display: "contents" }}>
                    <span>{i.label}</span>
                    <span style={{ fontFamily: MONO, fontSize: 12, color: T.ink }}>{i.default}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {(s.signals.length > 0 || s.alerts.length > 0) && (
            <>
              {head("SIGNALS · ALERTS")}
              <ul style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                {s.signals.map((x, i) => <li key={`s${i}`}>{x}</li>)}
                {s.alerts.map((x, i) => <li key={`a${i}`} style={{ color: T.muted }}>{x}</li>)}
              </ul>
            </>
          )}

          {s.iqHook && (
            <div style={{ marginTop: 12, fontFamily: MONO, fontSize: 11.5, color: T.accentLt }}>
              IQ HOOK · {s.iqHook.source}
              {s.iqHook.use ? ` — ${s.iqHook.use}` : ""}
            </div>
          )}

          {s.twist && (
            <>
              {head("THE TWIST")}
              <div>{s.twist}</div>
            </>
          )}

          {s.render && (
            <div style={{ marginTop: 12, fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: T.ghost }}>
              PREVIEW DRAWN ON THE WORKBENCH CHART →
            </div>
          )}

          {s.chips.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
              {s.chips.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  disabled={busy}
                  onClick={() => onChip(c)}
                  style={
                    i === 0
                      ? { borderRadius: 999, border: `1px solid ${T.accent}`, background: T.accent, color: "#fff", fontFamily: SANS, fontSize: 12.5, fontWeight: 700, padding: "7px 14px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }
                      : { borderRadius: 999, border: `1px solid ${T.hairline}`, background: "transparent", color: T.muted, fontFamily: SANS, fontSize: 12.5, padding: "7px 14px", cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }
                  }
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BrainstormPanel({
  ticker,
  seed,
  onSpec,
  onClose,
  onError,
}: {
  ticker: string | null;
  seed: string;
  onSpec: (spec: BrainSpec) => void;
  onClose: () => void;
  onError: (msg: string) => void;
}) {
  const [q, setQ] = useState<BrainQuestion | null>(null);
  const [answers, setAnswers] = useState<{ question: string; answer: string }[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [freeOpen, setFreeOpen] = useState(false);
  const [free, setFree] = useState("");
  const [loading, setLoading] = useState(true);
  const startedRef = useRef(false);
  const seedRef = useRef(seed);
  const tickerRef = useRef(ticker);

  const fail = useCallback(
    (e: unknown) => {
      const msg = String((e as { message?: string })?.message ?? e);
      if (/plus_required|403/.test(msg)) onError("Blueprint is an IQ Plus feature.");
      else onError("The blueprint didn't go through. Your credit wasn't used.");
      onClose();
    },
    [onClose, onError],
  );

  const run = useCallback(
    async (next: { question: string; answer: string }[], finish: boolean) => {
      setLoading(true);
      setPicked([]);
      setFreeOpen(false);
      setFree("");
      try {
        const r = await askStructured({
          mode: "brainstorm",
          ticker: tickerRef.current ?? undefined,
          answers: next,
          question: seedRef.current || undefined,
          finish,
        });
        if (r.kind === "spec") onSpec(toSpec(r));
        else {
          setQ(r);
          setLoading(false);
        }
      } catch (e) {
        fail(e);
      }
    },
    [fail, onSpec],
  );

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void run([], false);
  }, [run]);

  const submit = useCallback(
    (answer: string) => {
      if (!q || !answer.trim()) return;
      const next = [...answers, { question: q.question, answer: answer.trim() }];
      setAnswers(next);
      void run(next, next.length >= 3);
    },
    [answers, q, run],
  );

  const step = Math.min(answers.length + 1, 3);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (q) submit("no preference — pick the sensible default");
        return;
      }
      if (!q || freeOpen || loading) return;
      const k = e.key.toUpperCase();
      const opt = q.options?.find((o) => (o.key ?? "").toUpperCase() === k);
      if (opt) {
        e.preventDefault();
        if (q.multi) setPicked((p) => (p.includes(opt.label) ? p.filter((x) => x !== opt.label) : [...p, opt.label]));
        else submit(opt.label);
      } else if (e.key === "Enter" && q.multi && picked.length) {
        e.preventDefault();
        submit(picked.join(", "));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [q, picked, freeOpen, loading, submit]);

  return (
    <div
      style={{
        position: "absolute",
        left: 22,
        right: 22,
        bottom: 96,
        zIndex: 40,
        background: T.menu,
        border: `1px solid ${T.hairline}`,
        borderRadius: 18,
        boxShadow: "0 22px 60px rgba(0,0,0,.45)",
        padding: "16px 18px",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.accentLt }}>
        <span>✦ BLUEPRINT{ticker ? ` · ${ticker}` : ""}</span>
        <span style={{ color: T.ghost }}>{step} OF 3</span>
      </div>

      {loading || !q ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 14 }}>
          <TypingBubble />
          <div style={{ fontFamily: MONO, fontSize: 10.5, color: T.faint }}>
            {answers.length >= 3 ? "Writing the spec…" : ticker ? `Reading ${ticker}'s engine states…` : "Thinking it through…"}
          </div>
        </div>
      ) : (
        <>
          <div style={{ marginTop: 12, fontFamily: SANS, fontSize: 15, fontWeight: 600, color: T.ink }}>{q.question}</div>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 7 }}>
            {(q.options ?? []).slice(0, 5).map((o, i) => {
              const key = (o.key ?? String.fromCharCode(65 + i)).toUpperCase();
              const on = picked.includes(o.label);
              return (
                <button
                  key={key + i}
                  type="button"
                  onClick={() => {
                    if (q.multi) setPicked((p) => (p.includes(o.label) ? p.filter((x) => x !== o.label) : [...p, o.label]));
                    else submit(o.label);
                  }}
                  className="iqa-menu-item"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 11,
                    textAlign: "left",
                    borderRadius: 12,
                    border: `1px solid ${on ? T.accentBorder : T.hairline}`,
                    background: on ? T.accentTint : "transparent",
                    padding: "10px 13px",
                    fontFamily: SANS,
                    fontSize: 13.5,
                    color: on ? T.ink : T.body,
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: on ? T.accentLt : T.faint, border: `1px solid ${T.hairline}`, borderRadius: 6, padding: "2px 6px" }}>{key}</span>
                  {o.label}
                </button>
              );
            })}

            {freeOpen ? (
              <input
                autoFocus
                value={free}
                onChange={(e) => setFree(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit(free);
                  }
                }}
                placeholder="Describe it in your own words…"
                style={{ borderRadius: 12, border: `1px solid ${T.hairline}`, background: T.inputFill, padding: "10px 13px", fontFamily: SANS, fontSize: 13.5, color: T.ink }}
              />
            ) : (
              <button
                type="button"
                onClick={() => setFreeOpen(true)}
                className="iqa-menu-item"
                style={{ textAlign: "left", borderRadius: 12, border: `1px dashed ${T.hairline}`, background: "transparent", padding: "10px 13px", fontFamily: SANS, fontSize: 13.5, color: T.faint, cursor: "pointer" }}
              >
                My own idea…
              </button>
            )}
          </div>

          <div style={{ marginTop: 14, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 8 }}>
              {answers.length >= 1 && (
                <button
                  type="button"
                  onClick={() => void run(answers, true)}
                  style={{ borderRadius: 999, border: `1px solid ${T.hairline}`, background: "transparent", padding: "8px 14px", fontFamily: SANS, fontSize: 12.5, color: T.muted, cursor: "pointer" }}
                >
                  Draft it now
                </button>
              )}
              <button
                type="button"
                onClick={() => submit("no preference — pick the sensible default")}
                style={{ borderRadius: 999, border: "1px solid transparent", background: "transparent", padding: "8px 12px", fontFamily: MONO, fontSize: 11, color: T.ghost, cursor: "pointer" }}
              >
                Skip Esc
              </button>
            </div>
            <button
              type="button"
              className="iqa-primary"
              disabled={q.multi ? picked.length === 0 : !freeOpen || !free.trim()}
              onClick={() => submit(q.multi ? picked.join(", ") : free)}
              style={{
                borderRadius: 999,
                border: "none",
                background: T.accent,
                color: "#fff",
                fontFamily: SANS,
                fontSize: 12.5,
                fontWeight: 700,
                padding: "9px 16px",
                cursor: "pointer",
                opacity: (q.multi ? picked.length === 0 : !freeOpen || !free.trim()) ? 0.4 : 1,
              }}
            >
              {step === 3 ? "Draft it ⏎" : "Continue ⏎"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------- Pine workspace (LuxAlgo layout) ----------------
   For the Pine Copilot the desk splits: chat on the left, a sticky rail on
   the right with the latest script and a real chart. Scripts never render
   raw inside bubbles on desktop — the bubble carries the conversation, the
   rail carries the code. On narrow screens the rail hides and the script
   prints inline in the thread instead (.iqa-code-inline). */
const PINE_MARK = "//@version";

/* where the script starts in a reply: the version line, with or without the
   slashes the model sometimes drops, else the indicator()/strategy() line */
const CODE_START = /^[ \t]*(?:\/\/\s*)?@version\s*=\s*\d+[^\n]*$/m;
const DECL_START = /^[ \t]*(?:indicator|strategy)\s*\(/m;
function splitPine(text: string): { prose: string; code: string | null; render: WbRender | null } {
  let ix = text.indexOf(PINE_MARK);
  let missingVersion = false;
  if (ix < 0) {
    const m = text.match(CODE_START);
    if (m && m.index != null) ix = m.index;
    else {
      const dm = text.match(DECL_START);
      if (dm && dm.index != null) { ix = dm.index; missingVersion = true; }
    }
  }
  if (ix < 0) return { prose: text, code: null, render: null };
  /* the model is told never to fence code, but strip any ``` that slips
     through — backticks must never render in a bubble or the code panel */
  const prose = text.slice(0, ix).replace(/```[a-z]*/gi, "").trim();
  let code = text.slice(ix).replace(/```/g, "");
  /* normalise the version line so the copy pastes clean into the Pine editor */
  code = code.replace(/^[ \t]*(?:\/\/\s*)?@version\s*=\s*(\d+)/m, "//@version=$1");
  if (missingVersion) code = "//@version=6\n" + code;
  /* the RENDER trailer is machine data for the workbench chart, never shown */
  const rm = code.match(/\n\s*RENDER:\s*(none|\{[^\n]*\})\s*/i);
  const render = rm ? parseRender(rm[1]) : null;
  code = code.replace(/\n\s*RENDER:[^\n]*/gi, "").trim();
  return { prose, code, render };
}

function latestScript(msgs: Msg[]): { code: string; render: WbRender | null } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "ai") continue;
    if (m.kind === "spec" && m.spec) return { code: "", render: m.spec.render };
    const { code, render } = splitPine(m.text);
    if (code) return { code, render };
  }
  return null;
}

/* ---- script preview: the copilot ships a RENDER manifest with each build,
   drawn from a small primitive set the workbench can compute from bars.
   Invalid or missing manifests degrade to a clean candle chart. ---- */
type WbSrc = "close" | { calc: "ema" | "sma"; len: number };
type WbPlot =
  | { kind: "line"; calc: "ema" | "sma"; len: number; color?: string; width?: number }
  | { kind: "bb"; len: number; mult: number }
  | { kind: "donchian"; len: number }
  | { kind: "atrband"; len: number; mult: number }
  | { kind: "hline"; price: number; color?: string }
  | { kind: "marks"; a: WbSrc; b: WbSrc };
type WbRender = { plots: WbPlot[] };

const WB_KINDS = new Set(["line", "bb", "donchian", "atrband", "hline", "marks"]);

function parseRender(raw: string): WbRender | null {
  if (/^none$/i.test(raw.trim())) return null;
  try {
    const j = JSON.parse(raw) as { plots?: unknown };
    if (!Array.isArray(j.plots)) return null;
    const plots = (j.plots as WbPlot[]).filter((p) => p && typeof p === "object" && WB_KINDS.has((p as { kind?: string }).kind ?? "")).slice(0, 5);
    return plots.length ? { plots } : null;
  } catch {
    return null;
  }
}

const wbSma = (src: (number | null)[], len: number): (number | null)[] => {
  const out: (number | null)[] = new Array(src.length).fill(null);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v == null) continue;
    sum += v;
    n += 1;
    if (n > len) {
      const drop = src[i - len];
      if (drop != null) sum -= drop;
      n = len;
    }
    if (n === len) out[i] = sum / len;
  }
  return out;
};

const wbEma = (src: (number | null)[], len: number): (number | null)[] => {
  const out: (number | null)[] = new Array(src.length).fill(null);
  const k = 2 / (len + 1);
  let prev: number | null = null;
  const seed = wbSma(src, len);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    if (v == null) continue;
    if (prev == null) {
      if (seed[i] != null) prev = seed[i];
    } else {
      prev = v * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
};

function wbSeries(bars: Bar[], s: WbSrc): (number | null)[] {
  const close = bars.map((b) => b.close as number | null);
  if (s === "close") return close;
  return s.calc === "ema" ? wbEma(close, s.len) : wbSma(close, s.len);
}

function wbAtr(bars: Bar[], len: number): (number | null)[] {
  const tr: (number | null)[] = bars.map((b, i) =>
    i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)),
  );
  return wbEma(tr, len);
}

function wbStdev(bars: Bar[], len: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = len - 1; i < bars.length; i++) {
    let m = 0;
    for (let j = i - len + 1; j <= i; j++) m += bars[j].close;
    m /= len;
    let v = 0;
    for (let j = i - len + 1; j <= i; j++) v += (bars[j].close - m) ** 2;
    out[i] = Math.sqrt(v / len);
  }
  return out;
}

const wbExtreme = (bars: Bar[], len: number, hi: boolean): (number | null)[] => {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  for (let i = len - 1; i < bars.length; i++) {
    let x = hi ? -Infinity : Infinity;
    for (let j = i - len + 1; j <= i; j++) x = hi ? Math.max(x, bars[j].high) : Math.min(x, bars[j].low);
    out[i] = x;
  }
  return out;
};

const WB_LINE_COLORS = ["#FFAA00", "#36A845", "#D11D17", "#8595B4"];

function CopyPill({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="iqa-quiet-pill"
      onClick={() => {
        void navigator.clipboard?.writeText(code).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      style={{
        borderRadius: 999,
        border: `1px solid ${copied ? "rgba(8,153,129,.5)" : T.hairline}`,
        background: "transparent",
        padding: "4px 12px",
        fontFamily: MONO,
        fontSize: 9.5,
        letterSpacing: "0.1em",
        color: copied ? T.mint : T.muted,
        cursor: "pointer",
      }}
    >
      {copied ? "COPIED" : "COPY"}
    </button>
  );
}

/* The narrow-screen fallback: the script inline in the thread. Hidden on
   desktop by .iqa-code-inline (the rail owns the code there). */
function InlineScript({ code }: { code: string }) {
  return (
    <div className="iqa-code-inline iqa-msg" style={{ alignSelf: "flex-start", width: "100%", maxWidth: 560 }}>
      <div style={{ background: T.panel, border: `1px solid ${T.hairline}`, borderRadius: 12, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", borderBottom: `1px solid ${T.hairlineSoft}` }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: T.faint }}>PINE V6 · SCRIPT</span>
          <CopyPill code={code} />
        </div>
        <pre style={{ margin: 0, padding: "12px 14px", maxHeight: 280, overflow: "auto", fontFamily: MONO, fontSize: 11, lineHeight: 1.6, color: T.body, whiteSpace: "pre" }}>
          {code}
        </pre>
      </div>
    </div>
  );
}

type WbTf = "1MIN" | "D" | "W" | "M";
const WB_VIEW: Record<WbTf, number> = { "1MIN": 390, D: 220, W: 160, M: 120 };

/* A CLEAN candle chart — no IQ overlay. This canvas belongs to the user's
   own indicator: when the copilot builds a script, its RENDER manifest is
   drawn here automatically; until then, bare candles. */
/* lightweight-charts paints a canvas: it needs real colours, never CSS
   variables. Resolve the theme token at mount time (the chart is created in
   an effect, so the computed style is the live theme). */
function cssColor(token: string, fallback: string): string {
  const m = token.match(/^var\((--[\w-]+)\)$/);
  if (!m) return token;
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim();
  return v || fallback;
}

function WbChart({ bars, tf, render, notice }: { bars: Bar[]; tf: WbTf; render: WbRender | null; notice?: string | null }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || bars.length < 2) return;
    const chart: IChartApi = createChart(el, {
      height: el.clientHeight || 400,
      layout: { background: { color: "transparent" }, textColor: cssColor(T.faint, "#5C6E93"), fontSize: 10, fontFamily: MONO },
      grid: {
        vertLines: { color: cssColor(T.hairline, "rgba(255,255,255,0.04)") },
        horzLines: { color: cssColor(T.hairline, "rgba(255,255,255,0.04)") },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: tf === "1MIN", secondsVisible: false, rightOffset: 6 },
      crosshair: {
        vertLine: { visible: false, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    const view = bars.slice(-WB_VIEW[tf]);
    const cut = bars.length - view.length;
    const candles = chart.addCandlestickSeries({
      upColor: IQ_GREEN,
      downColor: IQ_RED,
      borderVisible: false,
      wickUpColor: IQ_GREEN,
      wickDownColor: IQ_RED,
    });
    candles.setData(view.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));

    /* draw the user's indicator from its manifest (series computed over the
       FULL history for correct warmup, then sliced to the view) */
    const toLine = (vals: (number | null)[]) =>
      view.map((b, i) => ({ time: b.time as UTCTimestamp, value: vals[cut + i] })).filter((p): p is { time: UTCTimestamp; value: number } => p.value != null);
    const addLine = (vals: (number | null)[], color: string, width: 1 | 2 = 2) => {
      const s = chart.addLineSeries({ color, lineWidth: width, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(toLine(vals));
    };
    if (render) {
      let ci = 0;
      const nextColor = () => WB_LINE_COLORS[ci++ % WB_LINE_COLORS.length];
      for (const p of render.plots) {
        try {
          if (p.kind === "line") {
            addLine(wbSeries(bars, { calc: p.calc, len: p.len }), p.color ?? nextColor(), (p.width === 1 ? 1 : 2));
          } else if (p.kind === "bb") {
            const basis = wbSma(bars.map((b) => b.close), p.len);
            const sd = wbStdev(bars, p.len);
            addLine(basis, "#8595B4", 1);
            addLine(basis.map((v, i) => (v != null && sd[i] != null ? v + p.mult * (sd[i] as number) : null)), "#36A845", 1);
            addLine(basis.map((v, i) => (v != null && sd[i] != null ? v - p.mult * (sd[i] as number) : null)), "#D11D17", 1);
          } else if (p.kind === "donchian") {
            addLine(wbExtreme(bars, p.len, true), "#36A845", 1);
            addLine(wbExtreme(bars, p.len, false), "#D11D17", 1);
          } else if (p.kind === "atrband") {
            const basis = wbEma(bars.map((b) => b.close), p.len);
            const atr = wbAtr(bars, p.len);
            addLine(basis, "#8595B4", 1);
            addLine(basis.map((v, i) => (v != null && atr[i] != null ? v + p.mult * (atr[i] as number) : null)), "#36A845", 1);
            addLine(basis.map((v, i) => (v != null && atr[i] != null ? v - p.mult * (atr[i] as number) : null)), "#D11D17", 1);
          } else if (p.kind === "hline") {
            if (typeof p.price === "number" && isFinite(p.price)) {
              candles.createPriceLine({ price: p.price, color: p.color ?? "#FFAA00", lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: "" });
            }
          } else if (p.kind === "marks") {
            const a = wbSeries(bars, p.a);
            const b = wbSeries(bars, p.b);
            const marks: { time: UTCTimestamp; position: "belowBar" | "aboveBar"; color: string; shape: "arrowUp" | "arrowDown" }[] = [];
            for (let i = Math.max(1, cut); i < bars.length; i++) {
              const a0 = a[i - 1], a1 = a[i], b0 = b[i - 1], b1 = b[i];
              if (a0 == null || a1 == null || b0 == null || b1 == null) continue;
              if (a0 <= b0 && a1 > b1) marks.push({ time: bars[i].time as UTCTimestamp, position: "belowBar", color: IQ_GREEN, shape: "arrowUp" });
              else if (a0 >= b0 && a1 < b1) marks.push({ time: bars[i].time as UTCTimestamp, position: "aboveBar", color: IQ_RED, shape: "arrowDown" });
            }
            candles.setMarkers(marks);
          }
        } catch {
          /* one bad plot never kills the chart */
        }
      }
    }
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [bars, tf, render]);
  if (bars.length < 2) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 30px", textAlign: "center", fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", color: T.faint }}>
        {notice ?? "LOADING PRICE…"}
      </div>
    );
  }
  return <div ref={ref} style={{ flex: 1, minHeight: 0 }} />;
}

const WB_TFS: WbTf[] = ["1MIN", "D", "W", "M"];

/* file the script in the Lab: same name → a new version */
function SavePill({ code, render, chatId, onSaved }: { code: string; render: WbRender | null; chatId?: string; onSaved?: (s: SavedScript) => void }) {
  const [state, setState] = useState<"idle" | "saved">("idle");
  const [v, setV] = useState(1);
  return (
    <button
      type="button"
      onClick={() => { const s = saveScript({ code, render, chatId }); setV(s.versions.length); setState("saved"); onSaved?.(s); window.setTimeout(() => setState("idle"), 1800); }}
      style={{ borderRadius: 999, border: `1px solid ${state === "saved" ? "rgba(8,153,129,.5)" : T.accentBorderSoft}`, background: state === "saved" ? "rgba(8,153,129,.1)" : T.accentTint, padding: "4px 12px", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: state === "saved" ? "#089981" : T.ink, cursor: "pointer", whiteSpace: "nowrap" }}
    >
      {state === "saved" ? `SAVED · v${v}` : "SAVE SCRIPT"}
    </button>
  );
}

function PineWorkbench({ latest, chatId, linked, onSaved, onBacktest }: {
  latest: { code: string; render: WbRender | null } | null;
  chatId?: string;
  /** the saved script this chat is filed under, if any */
  linked?: SavedScript | null;
  onSaved?: (s: SavedScript) => void;
  onBacktest?: () => void;
}) {
  /* a pinned version shows instead of the live script (-1 = live) */
  const [pinned, setPinned] = useState(-1);
  useEffect(() => { setPinned(-1); }, [chatId, linked?.versions.length]);
  const pinnedV = linked && pinned >= 0 && pinned < linked.versions.length ? linked.versions[pinned] : null;
  const script = pinnedV ? pinnedV.code : latest?.code ?? null;
  const render = pinnedV ? pinnedV.render : latest?.render ?? null;
  const [view, setView] = useState<"chart" | "code" | "audit" | "backtest">("chart");
  /* a new script in THIS chat opens the code (owner 2026-09-04); opening
     another chat keeps the chart */
  const seen = useRef<{ chatId?: string; code: string | null }>({ chatId, code: latest?.code ?? null });
  useEffect(() => {
    const prev = seen.current;
    const code = latest?.code ?? null;
    if (prev.chatId === chatId && code && code !== prev.code) setView("code");
    seen.current = { chatId, code };
  }, [chatId, latest?.code]);
  /* 1-minute is the desk default — the copilot builds intraday tools */
  const [tf, setTf] = useState<WbTf>("1MIN");
  /* default to a scan-universe flagship — the feeds cover the scanned
     large caps, not ETFs, so SPY-style symbols have no bars */
  const [sym, setSym] = useState("NVDA");
  const [draft, setDraft] = useState("NVDA");
  /* 1m is a per-symbol feed covering the signals book + top caps (a 404
     means "not covered today"); D/W/M are engine-grade per-symbol feeds —
     no client resample anywhere */
  const bars1mQ = useQuery({ ...iqBars1mQuery(sym), enabled: tf === "1MIN", retry: 1 });
  const barsDQ = useQuery({ ...barsDailyQuery(sym), enabled: tf === "D", retry: 1 });
  const barsWQ = useQuery({ ...barsWeeklyQuery(sym), enabled: tf === "W", retry: 1 });
  const barsMQ = useQuery({ ...barsMonthlyQuery(sym), enabled: tf === "M", retry: 1 });
  const rows1m = tf === "1MIN" ? bars1mQ.data : undefined;
  const bars =
    tf === "1MIN"
      ? rows1m
        ? rows1mToBars(rows1m)
        : []
      : (tf === "D" ? barsDQ.data : tf === "W" ? barsWQ.data : barsMQ.data) ?? [];
  const notice =
    tf === "1MIN"
      ? bars1mQ.isError
        ? `NO 1-MINUTE FEED FOR ${sym} TODAY — IT COVERS THE SIGNALS BOOK AND TOP CAPS. PICK D / W / M`
        : null
      : (tf === "D" ? barsDQ : tf === "W" ? barsWQ : barsMQ).isError
        ? "NO FEED FOR THIS SYMBOL — THE CHART COVERS THE SCAN UNIVERSE (LARGE-CAP STOCKS)"
        : null;
  /* a fresh build announces itself: previewable script → the chart, where
     it just got drawn; otherwise → the code panel */
  const prevScript = useRef<string | null>(null);
  useEffect(() => {
    if (script && script !== prevScript.current) setView(render ? "chart" : "code");
    prevScript.current = script;
  }, [script, render]);
  const commit = () => {
    const s = draft.trim().toUpperCase();
    if (/^[A-Z0-9.-]{1,12}$/.test(s)) setSym(s);
    else setDraft(sym);
  };
  const seg = (on: boolean): React.CSSProperties => ({
    borderRadius: 999,
    border: `1px solid ${on ? T.accentBorderSoft : "transparent"}`,
    background: on ? T.accentTint : "transparent",
    padding: "4px 12px",
    fontFamily: MONO,
    fontSize: 9.5,
    letterSpacing: "0.1em",
    color: on ? T.ink : T.faint,
    cursor: "pointer",
  });
  return (
    <aside
      className="iqa-workbench"
      style={{
        flex: 1,
        minWidth: 520,
        background: T.surface,
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      {/* workspace header: CHART/CODE toggle + the controls for the active view */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 14px", borderBottom: `1px solid ${T.hairlineSoft}`, flexShrink: 0 }}>
        <div style={{ display: "inline-flex", gap: 4, border: `1px solid ${T.hairlineSoft}`, borderRadius: 999, padding: 3 }}>
          <button type="button" onClick={() => setView("chart")} style={seg(view === "chart")}>CHART</button>
          <button type="button" onClick={() => setView("code")} style={seg(view === "code")}>CODE</button>
          <button type="button" onClick={() => setView("audit")} style={seg(view === "audit")}>AUDIT</button>
          <button type="button" onClick={() => setView("backtest")} style={seg(view === "backtest")}>BACKTEST</button>
        </div>
        {view === "chart" ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {script && <SavePill code={script} render={render} chatId={chatId} onSaved={onSaved} />}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
              }}
              onBlur={commit}
              aria-label="Chart symbol"
              style={{
                width: 84,
                borderRadius: 999,
                border: `1px solid ${T.hairline}`,
                background: T.raised,
                padding: "4px 10px",
                fontFamily: MONO,
                fontSize: 11,
                letterSpacing: "0.06em",
                color: T.ink,
                textAlign: "center",
              }}
            />
            <div style={{ display: "inline-flex", gap: 2 }}>
              {WB_TFS.map((t) => (
                <button key={t} type="button" onClick={() => setTf(t)} style={seg(tf === t)}>{t}</button>
              ))}
            </div>
          </div>
        ) : (
          script && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><SavePill code={script} render={render} chatId={chatId} onSaved={onSaved} /><CopyPill code={script} /></div>
        )}
      </div>

      {linked && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", borderBottom: `1px solid ${T.hairlineSoft}`, flexShrink: 0, flexWrap: "wrap" }}>
          <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.faint }}>{linked.name.toUpperCase()}</span>
          <VersionPills script={linked} vIdx={pinnedV ? pinned : linked.versions.findIndex((v) => v.code === latest?.code)} onPick={(i) => setPinned(latest?.code === linked.versions[i].code ? -1 : i)} />
          {pinnedV && <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: T.accentLt }}>SHOWING v{pinnedV.v} · NOT THE CHAT'S LATEST</span>}
          {!pinnedV && latest?.code && !linked.versions.some((v) => v.code === latest.code) && <span style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: T.amber }}>LIVE · NOT SAVED YET</span>}
          {onBacktest && <button type="button" onClick={onBacktest} style={{ marginLeft: "auto", borderRadius: 999, border: `1px solid ${T.accentBorderSoft}`, background: "transparent", padding: "3px 10px", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: T.accentLt, cursor: "pointer" }}>OPEN IN BACKTEST →</button>}
        </div>
      )}

      {/* body: the user's chart (their indicator drawn when built), or the code */}
      {view === "chart" ? (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "10px 10px 0" }}>
          <WbChart bars={bars} tf={tf} render={render} notice={notice} />
          <div style={{ padding: "8px 6px 9px", fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: T.ghost, flexShrink: 0 }}>
            {sym} · {tf === "1MIN" ? "1-MINUTE" : tf === "D" ? "DAILY" : tf === "W" ? "WEEKLY" : "MONTHLY"} ·{" "}
            {render
              ? "YOUR SCRIPT · APPROXIMATE PREVIEW — EXACT RENDER IN TRADINGVIEW"
              : script
                ? "NO CHART PREVIEW FOR THIS SCRIPT — PASTE IT INTO TRADINGVIEW"
                : "CLEAN CHART — YOUR INDICATOR PREVIEWS HERE ONCE BUILT"}
          </div>
        </div>
      ) : view === "audit" && script ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}><AuditView code={script} /></div>
      ) : view === "backtest" && script ? (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}><BacktestView name={nameFromCode(script)} vLabel="current build" code={script} render={render} /></div>
      ) : script ? (
        <pre style={{ flex: 1, minHeight: 0, margin: 0, padding: "14px 16px 18px", overflow: "auto", fontFamily: MONO, fontSize: 11.5, lineHeight: 1.65, color: T.body, whiteSpace: "pre" }}>
          {script}
        </pre>
      ) : (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 40px", textAlign: "center" }}>
          <p style={{ fontFamily: SANS, fontSize: 13, lineHeight: 1.6, color: T.faint }}>
            The script lands here once we build it. Describe the idea — the copilot asks what it needs to know, then writes the Pine.
          </p>
        </div>
      )}
      <div style={{ padding: "9px 16px", borderTop: `1px solid ${T.hairlineSoft}`, fontFamily: MONO, fontSize: 8.5, letterSpacing: "0.1em", color: T.ghost, flexShrink: 0 }}>
        PASTE INTO THE TRADINGVIEW PINE EDITOR · YOUR CODE STAYS YOURS
      </div>
    </aside>
  );
}

/* ---------------- grounded setup card (§4.2b) ---------------- */
const regimeColor = (r: "bull" | "bear") => (r === "bull" ? IQ_GREEN : IQ_RED);

const oscArrow = (o: Osc) => (o === "RISING" ? "▲" : o === "FALLING" ? "▼" : "→");
const oscColor = (o: Osc) => (o === "RISING" ? IQ_GREEN : o === "FALLING" ? IQ_RED : T.neutral);

type Level = { label: string; price: number; tone: string };

function computeLevels(snap: SetupSnap, bars: Bar[]): Level[] {
  const win = bars.slice(-90);
  const hi = snap.levels.swingHi ?? (win.length ? Math.max(...win.map((b) => b.high)) : null);
  const lo = snap.levels.swingLo ?? (win.length ? Math.min(...win.map((b) => b.low)) : null);
  let basis: number | null = null;
  if (snap.levels.regimeLo != null && snap.levels.regimeHi != null) basis = (snap.levels.regimeLo + snap.levels.regimeHi) / 2;
  else if (snap.d?.basisPct != null && snap.price != null) basis = snap.price / (1 + snap.d.basisPct / 100);
  const out: Level[] = [];
  if (hi != null) out.push({ label: "Resistance", price: hi, tone: IQ_RED });
  if (basis != null) out.push({ label: "Basis", price: basis, tone: T.neutral });
  if (lo != null) out.push({ label: "Support", price: lo, tone: IQ_GREEN });
  return out;
}

/* Real TradingView chart (lightweight-charts): candles + dashed level lines
   with axis labels, read-only — no scroll/zoom hijacking inside a chat card. */
function SetupChart({ bars, levels }: { bars: Bar[]; levels: Level[] }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || bars.length < 2) return;
    const chart: IChartApi = createChart(el, {
      height: 190,
      layout: { background: { color: "transparent" }, textColor: cssColor(T.faint, "#5C6E93"), fontSize: 10, fontFamily: MONO },
      grid: {
        vertLines: { color: cssColor(T.hairline, "rgba(255,255,255,0.04)") },
        horzLines: { color: cssColor(T.hairline, "rgba(255,255,255,0.04)") },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: false, secondsVisible: false, rightOffset: 6 },
      crosshair: {
        vertLine: { visible: false, labelVisible: false },
        horzLine: { visible: false, labelVisible: false },
      },
      handleScroll: false,
      handleScale: false,
    });
    const candles = chart.addCandlestickSeries({
      upColor: IQ_GREEN,
      downColor: IQ_RED,
      borderVisible: false,
      wickUpColor: IQ_GREEN,
      wickDownColor: IQ_RED,
    });
    candles.setData(
      bars.slice(-90).map((b) => ({
        time: b.time as UTCTimestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );
    // No in-pane title boxes — they bury the newest candles; the colored
    // axis price + the LEVELS TO WATCH list below carry the names.
    for (const l of levels) {
      candles.createPriceLine({
        price: l.price,
        color: l.tone,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
    }
    chart.timeScale().fitContent();
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [bars, levels]);

  if (bars.length < 2) {
    return (
      <div style={{ height: 190, borderRadius: 10, border: `1px dashed ${T.hairline}`, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10.5, letterSpacing: "0.1em", color: T.faint }}>
        LOADING PRICE…
      </div>
    );
  }
  return <div ref={ref} style={{ width: "100%" }} />;
}

function RegimeTile({ tf, label }: { tf: TfSnap; label: string }) {
  if (!tf) {
    return (
      <div style={{ flex: 1, padding: "9px 10px", borderRadius: 10, border: `1px solid ${T.hairlineSoft}`, background: T.raised }}>
        <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: T.ghost }}>{label}</div>
        <div style={{ fontFamily: MONO, fontSize: 11, color: T.faint, marginTop: 8 }}>no read</div>
      </div>
    );
  }
  const col = regimeColor(tf.regime);
  return (
    <div style={{ flex: 1, padding: "9px 10px", borderRadius: 10, border: `1px solid ${T.hairlineSoft}`, background: T.raised }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: T.faint }}>{label}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: T.ghost }}>{tf.age != null ? `d${tf.age}` : "—"}</span>
      </div>
      {/* regime and momentum are separate facts — label the arrow so a green
          BULL next to a red arrow reads as "bull regime, wave falling", not a bug */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
        <span style={{ fontFamily: MONO, fontSize: 10.5, fontWeight: 700, letterSpacing: "0.06em", color: col }}>{tf.regime === "bull" ? "BULL" : "BEAR"}</span>
        <span style={{ fontFamily: MONO, fontSize: 9, color: oscColor(tf.osc) }}>WAVE {oscArrow(tf.osc)}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 7 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: tf.flow === "BUYING" ? IQ_GREEN : tf.flow === "SELLING" ? IQ_RED : T.faint }}>{tf.flow ?? "—"}</span>
        <span style={{ display: "inline-flex", gap: 2 }}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} style={{ width: 4, height: 4, borderRadius: "50%", background: i < (tf.conf ?? 0) ? col : T.ghost }} />
          ))}
        </span>
      </div>
    </div>
  );
}

function SetupCard({ snap, bars }: { snap: SetupSnap; bars: Bar[] }) {
  const bias = netBias(snap);
  // Memoized so the chart effect doesn't rebuild on every parent re-render
  // (the thread re-renders on each composer keystroke).
  const levels = useMemo(() => computeLevels(snap, bars), [snap, bars]);
  return (
    <div style={{ background: T.panel, border: `1px solid ${T.hairline}`, borderRadius: 14, padding: 14, width: "100%" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: T.ink }}>{snap.sym}</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: T.muted }}>{fmtPrice(snap.price)}</span>
        </div>
        <span style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em", color: bias.color, border: `1px solid ${bias.color}55`, background: `${bias.color}14`, borderRadius: 999, padding: "3px 9px" }}>
          {bias.label}
        </span>
      </div>

      {/* chart with levels */}
      <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: T.ghost, margin: "0 0 6px" }}>PRICE · DAILY · LAST 90 BARS</div>
      <SetupChart bars={bars} levels={levels} />

      {/* regime across timeframes */}
      <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: T.ghost, margin: "12px 0 7px" }}>REGIME · BY TIMEFRAME</div>
      <div style={{ display: "flex", gap: 8 }}>
        <RegimeTile tf={snap.d} label="DAILY" />
        <RegimeTile tf={snap.w} label="WEEKLY" />
        <RegimeTile tf={snap.m} label="MONTHLY" />
      </div>

      {/* levels to watch */}
      {levels.length > 0 && (
        <>
          <div style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.12em", color: T.ghost, margin: "12px 0 7px" }}>LEVELS TO WATCH</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {levels.map((l) => {
              const dist = snap.price != null ? ((l.price - snap.price) / snap.price) * 100 : null;
              return (
                <div key={l.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 2px", borderTop: `1px solid ${T.hairlineSoft}` }}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: l.tone }} />
                    <span style={{ fontFamily: SANS, fontSize: 12.5, color: T.body }}>{l.label}</span>
                  </span>
                  <span style={{ display: "inline-flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ fontFamily: MONO, fontSize: 12.5, fontWeight: 600, color: T.ink }}>${l.price.toFixed(2)}</span>
                    {dist != null && (
                      <span style={{ fontFamily: MONO, fontSize: 10.5, color: T.faint, minWidth: 52, textAlign: "right" }}>
                        {dist >= 0 ? "+" : ""}{dist.toFixed(1)}%
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}

      {snap.structEvents.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 11 }}>
          {snap.structEvents.slice(0, 4).map((e) => (
            <span key={e} style={{ fontFamily: MONO, fontSize: 9, letterSpacing: "0.06em", color: T.muted, border: `1px solid ${T.hairline}`, borderRadius: 999, padding: "3px 8px" }}>
              {e.toUpperCase()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SetupBubble({ m, bars }: { m: Msg; bars: Bar[] | undefined }) {
  const note = setupNote(m.text);
  return (
    <div className="iqa-msg iqa-bubble-wrap" style={{ maxWidth: "min(560px, 92%)", alignSelf: "flex-start" }}>
      <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.14em", color: T.accentLt, marginBottom: 7 }}>
        IQ ANALYST · GROUNDED
      </div>
      {m.setup && <SetupCard snap={m.setup} bars={bars ?? []} />}
      {note && (
        <div
          style={{
            marginTop: 10,
            background: T.bubbleAi,
            border: `1px solid ${T.hairlineSoft}`,
            borderRadius: "4px 16px 16px 16px",
            padding: "12px 16px",
            fontFamily: SANS,
            fontSize: 14,
            lineHeight: 1.6,
            color: T.body,
            whiteSpace: "pre-line",
          }}
        >
          <BubbleText text={note} />
        </div>
      )}
      {m.chips && m.chips.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
          {m.chips.map((c) => (
            <span key={c} style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.08em", color: T.faint, border: `1px solid ${T.hairline}`, borderRadius: 999, padding: "4px 10px" }}>
              {c}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- main page ---------------- */
type DeskSection = "analyst" | "quant";
/* the Analyst reads charts and coaches; Quant builds scripts. One desk,
   two sections, shared chat storage filtered by assistant. */
const SECTION_ASSISTANTS: Record<DeskSection, Assistant[]> = { analyst: ["chart", "coach"], quant: ["pine"] };
const SECTION_HOME: Record<DeskSection, "/analyst" | "/quant"> = { analyst: "/analyst", quant: "/quant" };

export function AnalystDesk({ section }: { section: DeskSection }) {
  const keys = SECTION_ASSISTANTS[section];
  const home = SECTION_HOME[section];
  /* Quant only: the saved-scripts library shown in place of the thread */
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [backtestOpen, setBacktestOpen] = useState(false);
  const [backtestSeed, setBacktestSeed] = useState<string | null>(null); // saved script id to open the panel on
  const [scriptsTick, setScriptsTick] = useState(0); // bumps when the library changes
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const screener = useQuery(iqScreenerQuery());
  const { data: credits } = useQuery({ queryKey: ["iqa", "credits"], queryFn: fetchCredits, staleTime: 60_000 });

  const reads = useMemo(() => {
    const m = new Map<string, TickerRead>();
    for (const r of (screener.data?.rows ?? []) as LevelRow[]) {
      const t = deriveRead(r);
      if (t) m.set(t.sym, t);
    }
    return m;
  }, [screener.data]);
  TICKER_COUNT_LABEL = screener.data ? String(screener.data.count) : "—";
  const scanTime = scanClock(screener.data?.updated_at);
  const screenerRef = useRef(screener.data);
  useEffect(() => {
    screenerRef.current = screener.data;
  }, [screener.data]);

  const [chats, setChats] = useState<Chat[]>(() => (typeof window === "undefined" ? [] : loadChats()));
  /* this desk lists only its own assistants' chats; storage is shared */
  const sectionChats = useMemo(() => chats.filter((c) => keys.includes(c.assistant)), [chats, keys]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<Assistant>(keys[0]);
  const [ticker, setTicker] = useState<string | null>(() =>
    typeof window === "undefined" ? null : localStorage.getItem(LS_TICKER),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingPillQ, setPendingPillQ] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<{ title: string; action: string; run: () => void } | null>(null);
  const [draftA, setDraftA] = useState("");
  const [draftB, setDraftB] = useState("");
  const [brainOpen, setBrainOpen] = useState(false);
  const [visionBusy, setVisionBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [showJump, setShowJump] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const queueRef = useRef<string[]>([]);

  const active = chats.find((c) => c.id === activeId) ?? null;
  /* the saved script this chat is filed under */
  const linked = useMemo(() => {
    if (!active || active.assistant !== "pine") return null;
    return (active.scriptId ? getScript(active.scriptId) : null) ?? findByChat(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.scriptId, scriptsTick]);
  const activeRead = active?.sym ? reads.get(active.sym) ?? null : null;
  const activeBars = useQuery(barsDailyQuery(active?.sym ?? ""));
  // Live snapshot for the open ticker — lets us upgrade setup answers to the
  // grounded card at render time, including ones stored before this shipped.
  const activeSnap = useMemo(
    () => buildSetupSnap((screener.data?.rows ?? []).find((r) => r.sym === active?.sym)),
    [screener.data, active?.sym],
  );
  const startRead = ticker ? reads.get(ticker) ?? null : null;
  const recents = useMemo(() => {
    const out: string[] = [];
    for (const c of chats) if (c.sym && !out.includes(c.sym)) out.push(c.sym);
    return out.slice(0, 3);
  }, [chats]);

  const persist = useCallback((next: Chat[]) => {
    setChats(next);
    saveChats(next);
  }, []);

  const toast = useCallback((dot: string, text: string, sub?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, dot, text, sub }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  /* ---- scripts ↔ chats ---- */
  /* a save from the workbench files the chat under that script */
  const onSaved = useCallback((s: SavedScript) => {
    if (activeId) persist(loadChats().map((c) => (c.id === activeId && c.scriptId !== s.id ? { ...c, scriptId: s.id } : c)));
    setScriptsTick((t) => t + 1);
  }, [activeId, persist]);
  /* a new version made elsewhere (optimiser, backtester) is announced in the creator chat */
  const onVersionCreated = useCallback((s: SavedScript, v: ScriptVersion, note: string) => {
    setScriptsTick((t) => t + 1);
    if (s.chatId) {
      const msg: Msg = { role: "ai", text: `Filed v${v.v} of "${s.name}" — ${note}. Say "continue from v${v.v}" and I will work from it, or tell me what to change.`, ts: Date.now(), sub: "QUANT · NEW VERSION", label: true };
      persist(loadChats().map((c) => (c.id === s.chatId ? { ...c, ts: Date.now(), messages: [...c.messages, msg] } : c)));
    }
    toast(T.mint, `v${v.v} filed`, s.name);
  }, [persist, toast]);
  /* the audit's fix button: back to the chat that built the script, request pre-typed */
  const openFixInChat = useCallback((ctx: FixContext) => {
    const chatId = ctx.script?.chatId;
    const all = loadChats();
    setLibraryOpen(false); setBacktestOpen(false);
    if (chatId && all.some((c) => c.id === chatId)) {
      setActiveId(chatId); setAssistant("pine");
      setDraftB(fixRequestText(ctx, false));
      window.setTimeout(() => document.querySelector<HTMLInputElement>("[data-iqa-composer-b]")?.focus(), 80);
    } else {
      setActiveId(null); setAssistant("pine");
      setDraftA(fixRequestText(ctx, true));
      window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("[data-iqa-composer]")?.focus(), 80);
    }
  }, []);
  const openBacktestFor = useCallback((scriptId: string | null) => { setBacktestSeed(scriptId); setLibraryOpen(false); setBacktestOpen(true); }, []);

  /* scripts follow the account: pull once per desk mount, push every change */
  useEffect(() => {
    if (section !== "quant") return;
    let alive = true;
    void installScriptSync().then((changed) => { if (alive && changed) setScriptsTick((t) => t + 1); });
    return () => { alive = false; };
  }, [section]);

  /* the copilot's fixes become versions of the linked script automatically */
  useEffect(() => {
    if (!active || active.assistant !== "pine" || !linked) return;
    const latest = latestScript(active.messages);
    if (!latest?.code) return;
    if (linked.versions.some((v) => v.code === latest.code)) return;
    const s2 = addVersion(linked.id, { code: latest.code, render: latest.render, note: "copilot fix" });
    if (s2) { setScriptsTick((t) => t + 1); toast(T.mint, `v${latestVersion(s2).v} filed`, `${s2.name} · from the copilot's reply`); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, active?.messages.length, linked?.id]);

  /* URL <-> state */
  useEffect(() => {
    const m = pathname.match(/\/analyst\/c\/([\w-]+)/);
    if (m && chats.some((c) => c.id === m[1])) setActiveId(m[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* /analyst?ticker=SYM — adopt the screener's handoff: bind the ticker and
     land on the focused start state. */
  const locSearch = useRouterState({ select: (s) => s.location.search as { ticker?: unknown } });
  const searchTicker = section === "analyst" && typeof locSearch.ticker === "string" && /^[A-Z0-9.-]{1,12}$/i.test(locSearch.ticker) ? locSearch.ticker.toUpperCase() : undefined;
  useEffect(() => {
    const t = searchTicker;
    if (!t) return;
    setTicker(t);
    try {
      localStorage.setItem(LS_TICKER, t);
    } catch {
      /* ignore */
    }
    setActiveId(null);
  }, [searchTicker]);
  const openChat = (id: string) => {
    setActiveId(id);
    setLibraryOpen(false);
    setBacktestOpen(false);
    const c = chats.find((x) => x.id === id);
    if (c) setAssistant(c.assistant);
    /* legacy /analyst/c/<id> URLs collapse back to the section root */
    if (!pathname.startsWith(home)) navigate({ to: home, replace: false });
  };
  const goStart = useCallback(() => {
    setActiveId(null);
    setLibraryOpen(false);
    setBacktestOpen(false);
    setDraftA("");
  }, []);

  /* keyboard shortcuts */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") { e.preventDefault(); goStart(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPickerOpen(true); }
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [goStart]);

  /* thread autoscroll */
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, busy]);

  const onThreadScroll = () => {
    const el = threadRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 200);
  };

  /* ----- submit flows (§6) ----- */
  const runAsk = useCallback(
    async (chatId: string, question: string) => {
      setBusy(true);
      const current = () => loadChats();
      try {
        const chat = current().find((c) => c.id === chatId);
        if (!chat) return;
        const history = chat.messages.slice(-6).map((m) => ({ role: m.role === "ai" ? "assistant" : "user", content: m.text }));
        const body =
          chat.assistant === "chart"
            ? { mode: "chat", ticker: chat.sym, question, history }
            : chat.assistant === "pine"
              ? { mode: "build", question, history }
              : { mode: "coach", question, history };
        const { answer } = await askServer(body);
        const isFirstAi = !chat.messages.some((m) => m.role === "ai");
        const isSetup =
          chat.assistant === "chart" &&
          (isFirstAi || /\b(set[\s-]?up|level|read|momentum|trend|bias|confluence|structure|support|resist|break)/i.test(question));
        const setup =
          isSetup && chat.sym
            ? buildSetupSnap((screenerRef.current?.rows ?? []).find((r) => r.sym === chat.sym)) ?? undefined
            : undefined;
        const chips =
          chat.assistant === "chart" && !setup && /\$\d/.test(answer)
            ? [`SCAN ${scanTime}`, "IQ BANDS · DAILY", "IQ OSC · DAILY"]
            : undefined;
        const next = current().map((c) =>
          c.id === chatId
            ? {
                ...c,
                snippet: c.snippet || question.toLowerCase(),
                messages: [
                  ...c.messages,
                  { role: "ai" as const, text: answer, ts: Date.now(), chips, label: isFirstAi, kind: setup ? ("setup" as const) : undefined, setup },
                ],
              }
            : c,
        );
        persist(next);
        void qc.invalidateQueries({ queryKey: ["iqa", "credits"] });
      } catch (e) {
        const plusGate = e instanceof Error && /plus_required|403/.test(e.message);
        const failText = plusGate
          ? "That assistant is an IQ Plus feature — upgrade on the pricing page to unlock Pine Copilot and the Trading Coach."
          : "That one didn't go through. Your credit wasn't used.";
        const next = current().map((c) =>
          c.id === chatId
            ? { ...c, messages: [...c.messages, { role: "ai" as const, text: failText, ts: Date.now() }] }

            : c,
        );
        persist(next);
      } finally {
        setBusy(false);
        const q = queueRef.current.shift();
        if (q) void sendInChat(chatId, q);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scanTime],
  );

  const submitStart = useCallback(
    (question: string) => {
      const copy = ASSISTANT_COPY[assistant];
      if (copy.needsTicker && !ticker) {
        setPendingPillQ(question);
        setPickerOpen(true);
        return;
      }
      const q = question.trim();
      if (!q) return;
      const id = `c${Date.now().toString(36)}`;
      const words = q.toLowerCase().split(/\s+/).slice(0, 4).join(" ");
      const chat: Chat = {
        id,
        assistant,
        sym: copy.needsTicker ? ticker : null,
        title: copy.needsTicker ? `${ticker} — ${words}` : words,
        snippet: q.toLowerCase(),
        ts: Date.now(),
        scanTag: scanTime,
        messages: [{ role: "user", text: q, ts: Date.now() }],
      };
      persist([chat, ...chats]);
      setActiveId(id);
      setDraftA("");
      void runAsk(id, q);
    },
    [assistant, ticker, chats, persist, runAsk, scanTime],
  );

  const sendInChat = useCallback(
    (chatId: string, question: string) => {
      const q = question.trim();
      if (!q) return;
      if (busy) {
        queueRef.current.push(q);
        return;
      }
      const next = loadChats().map((c) =>
        c.id === chatId ? { ...c, ts: Date.now(), messages: [...c.messages, { role: "user" as const, text: q, ts: Date.now() }] } : c,
      );
      persist(next);
      setDraftB("");
      void runAsk(chatId, q);
    },
    [busy, persist, runAsk],
  );

  /* A finished Brainstorm / vision spec lands as a spec card in a pine chat. */
  const openSpec = useCallback(
    (spec: BrainSpec) => {
      const ts = Date.now();
      const msg: Msg = { role: "ai", text: specToText(spec), ts, kind: "spec", spec, label: true };
      const all = loadChats();
      const current = all.find((c) => c.id === activeId);
      if (current && current.assistant === "pine") {
        persist(all.map((c) => (c.id === current.id ? { ...c, ts, messages: [...c.messages, msg] } : c)));
      } else {
        const id = `c${ts.toString(36)}`;
        const chat: Chat = {
          id,
          assistant: "pine",
          sym: null,
          title: spec.name,
          snippet: spec.oneLiner.toLowerCase(),
          ts,
          scanTag: scanTime,
          messages: [{ role: "user", text: `Blueprint: ${spec.oneLiner || spec.name}`, ts }, msg],
        };
        persist([chat, ...all]);
        setActiveId(id);
        setAssistant("pine");
        setDraftA("");
      }
      setBrainOpen(false);
      toast(T.mint, "Spec ready", spec.name);
      void qc.invalidateQueries({ queryKey: ["iqa", "credits"] });
    },
    [activeId, persist, qc, scanTime, toast],
  );

  const onSpecChip = useCallback(
    (chatId: string, spec: BrainSpec, chip: string) => {
      if (chip === spec.chips[0] || /build/i.test(chip)) sendInChat(chatId, specToBuildPrompt(spec));
      else sendInChat(chatId, `${chip} — for "${spec.name}"`);
    },
    [sendInChat],
  );

  const onPickImage = useCallback(
    async (file?: File) => {
      if (!file) return;
      setVisionBusy(true);
      try {
        const image = await fileToDataUrl(file);
        const r = await askStructured({ mode: "vision_spec", image, note: (draftA || draftB).trim() || undefined });
        if (r.kind === "spec") openSpec(toSpec(r));
        else throw new Error("bad_shape");
      } catch (e) {
        const msg = String((e as { message?: string })?.message ?? e);
        if (/no_indicator_visible/.test(msg)) toast(T.bear, "No indicator visible in that image");
        else if (/plus_required|403/.test(msg)) toast(T.bear, "Generate from image is an IQ Plus feature");
        else toast(T.bear, "Couldn't read that image", "Try a clearer chart screenshot — your credit wasn't used");
      } finally {
        setVisionBusy(false);
        if (fileRef.current) fileRef.current.value = "";
      }
    },
    [draftA, draftB, openSpec, toast],
  );

  /* picker pick */
  const pickTicker = (sym: string) => {
    setTicker(sym);
    localStorage.setItem(LS_TICKER, sym);
    setPickerOpen(false);
    if (pendingPillQ) {
      const q = pendingPillQ;
      setPendingPillQ(null);
      // ticker state updates async — submit with explicit values
      const id = `c${Date.now().toString(36)}`;
      const chat: Chat = {
        id,
        assistant: "chart",
        sym,
        title: `${sym} — ${q.toLowerCase().split(/\s+/).slice(0, 4).join(" ")}`,
        snippet: q.toLowerCase(),
        ts: Date.now(),
        scanTag: scanTime,
        messages: [{ role: "user", text: q, ts: Date.now() }],
      };
      persist([chat, ...chats]);
      setActiveId(id);
      void runAsk(id, q);
    }
  };

  const toggleAlert = () => {
    if (!active?.sym) return;
    const arming = !active.armed;
    if (arming) toast(T.mint, `Alert enabled on ${active.sym}`, "PUSH + EMAIL · FLIP OR MOMENTUM STALL");
    else toast(T.accent, `Alert disabled on ${active.sym}`);
    const msg = arming
      ? { role: "ai" as const, text: "Done — I'll message you if the read changes on this one. ✓", ts: Date.now(), sub: "Alert enabled — push + email." }
      : { role: "ai" as const, text: "Alert off — no more pings on this one. ✓", ts: Date.now(), sub: "Alert disabled." };
    const next = loadChats().map((c) =>
      c.id === active.id ? { ...c, armed: arming, messages: [...c.messages, msg] } : c,
    );
    persist(next);
  };

  const copy = ASSISTANT_COPY[assistant];
  const creditsLeft = credits?.left ?? null;
  const outOfCredits = creditsLeft === 0;

  /* ---------------- render ---------------- */
  return (
    <div className="iqa-root" style={{ flex: 1, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column", background: T.bg, color: T.ink }}>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />

      {/* full-bleed desk — the frame spans the viewport like the Screener
          and Signals pages; the sidebar and workbench rail hold the edges */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          width: "100%",
        }}
      >
        <Sidebar
          chats={sectionChats}
          assistants={ASSISTANTS.filter((a) => keys.includes(a.key))}
          extra={section === "quant" ? [
            { glyph: "◫", name: "Backtest", active: backtestOpen, onClick: () => { setBacktestSeed(null); setBacktestOpen(true); setLibraryOpen(false); } },
            { glyph: "▤", name: "Saved scripts", active: libraryOpen, onClick: () => { setLibraryOpen(true); setBacktestOpen(false); setActiveId(null); } },
          ] : []}
          activeId={activeId}
          assistant={assistant}
          reads={reads}
          credits={credits ?? null}
          onNew={goStart}
          onOpen={openChat}
          onSwitchAssistant={(a) => { setAssistant(a); goStart(); }}
          onDelete={(id) =>
            setConfirm({
              title: "Delete this chat?",
              action: "Delete",
              run: () => {
                persist(loadChats().filter((c) => c.id !== id));
                if (activeId === id) goStart();
              },
            })
          }
          onPin={(id) => persist(loadChats().map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)))}
          onRename={(id, title) => persist(loadChats().map((c) => (c.id === id ? { ...c, title } : c)))}
          onClear={() =>
            setConfirm({
              title: "Clear all chats?",
              action: "Clear all",
              run: () => {
                persist([]);
                goStart();
              },
            })
          }
        />

        {libraryOpen ? (
          <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, background: T.bg }}>
            <ScriptLibrary onBuild={goStart} onFix={openFixInChat} onVersion={onVersionCreated} />
          </main>
        ) : backtestOpen ? (
          <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, background: T.bg }}>
            <BacktestPanel key={`${active?.id ?? "none"}:${backtestSeed ?? ""}`} seedCode={active ? latestScript(active.messages)?.code ?? null : null} seedScriptId={backtestSeed ?? linked?.id ?? null} onBuild={goStart} onFix={openFixInChat} onVersion={onVersionCreated} />
          </main>
        ) : !active ? (
          <main style={{ flex: 1, minWidth: 0, position: "relative", display: "flex", flexDirection: "column" }}>
            <div aria-hidden="true" style={{ position: "absolute", inset: 0, background: "radial-gradient(60% 45% at 50% 38%, rgba(61,105,168,.06), transparent 70%)", pointerEvents: "none" }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", padding: "0 20px" }}>
              <div style={{ fontFamily: MONO, fontSize: 11, letterSpacing: "0.2em", color: T.accentLt }}>{section === "quant" ? LAB_LABEL.toUpperCase() : "IQ ANALYST"}</div>
              <h1 style={{ fontFamily: SANS, fontSize: 42, fontWeight: 700, letterSpacing: "-0.025em", color: T.ink, margin: "16px 0 0", textAlign: "center" }}>
                {copy.headline}
              </h1>
              {copy.subline(scanTime, TICKER_COUNT_LABEL) !== "" && (
                <p style={{ fontFamily: SANS, fontSize: 16, color: T.muted, margin: "12px 0 0", textAlign: "center" }}>
                  {copy.subline(scanTime, TICKER_COUNT_LABEL)}
                </p>
              )}

              <div
                style={{
                  marginTop: 38,
                  width: 760,
                  maxWidth: "calc(100% - 40px)",
                  border: "1px solid var(--iq-line)",
                  borderRadius: 20,
                  background: T.raised,
                  boxShadow: "0 30px 80px rgba(0,0,0,.5)",
                  padding: "20px 22px",
                  textAlign: "left",
                }}
              >
                <textarea
                  data-iqa-composer
                  value={draftA}
                  onChange={(e) => setDraftA(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (draftA.trim() && (!copy.needsTicker || ticker) && !outOfCredits) submitStart(draftA);
                    }
                  }}
                  placeholder={outOfCredits ? "Out of credits — resets at midnight" : copy.placeholder}
                  disabled={outOfCredits}
                  rows={2}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    resize: "none",
                    fontFamily: SANS,
                    fontSize: 16.5,
                    color: T.ink,
                    lineHeight: 1.5,
                    maxHeight: "9em",
                    opacity: outOfCredits ? 0.4 : 1,
                  }}
                />
                <div style={{ marginTop: 30, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", position: "relative", flexWrap: "wrap" }}>
                    {copy.needsTicker && (
                      <>
                        <button
                          type="button"
                          onClick={() => setPickerOpen((v) => !v)}
                          style={
                            ticker
                              ? { borderRadius: 999, border: `1px solid ${T.accentBorder}`, background: T.accentTint, fontFamily: MONO, fontSize: 12, fontWeight: 600, color: T.accentLt, padding: "7px 14px", cursor: "pointer" }
                              : { borderRadius: 999, border: `1px solid ${T.hairline}`, background: "transparent", fontFamily: MONO, fontSize: 12, color: T.faint, padding: "7px 14px", cursor: "pointer" }
                          }
                        >
                          {ticker ? `${ticker} ▾` : "Set a ticker ▾"}
                        </button>
                        {startRead && (
                          <span style={{ borderRadius: 999, border: `1px solid ${T.hairline}`, padding: "7px 14px", fontFamily: SANS, fontSize: 13, color: T.muted }}>
                            {fmtPrice(startRead.price)} · <span style={{ color: readColor(startRead) }}>{readWord(startRead)}</span>
                          </span>
                        )}
                        {pickerOpen && (
                          <TickerPicker reads={reads} recents={recents} onPick={pickTicker} onClose={() => setPickerOpen(false)} anchor="chip" />
                        )}
                      </>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    {outOfCredits && (
                      <Link to="/topup" className="iqa-primary" style={{ borderRadius: 999, padding: "8px 16px", background: T.accent, color: "#fff", fontFamily: SANS, fontSize: 12.5, fontWeight: 700, textDecoration: "none" }}>
                        Top up
                      </Link>
                    )}
                    <SendCircle
                      size={38}
                      hero
                      disabled={!draftA.trim() || (copy.needsTicker && !ticker) || outOfCredits}
                      onClick={() => submitStart(draftA)}
                    />
                  </div>
                </div>
              </div>

              {assistant === "pine" && (
                <div style={{ marginTop: 22, display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                  <button
                    type="button"
                    disabled={outOfCredits}
                    onClick={() => setBrainOpen(true)}
                    style={{ borderRadius: 999, border: `1px solid ${T.accentBorder}`, background: T.accentTint, padding: "9px 17px", fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: T.accentLt, cursor: outOfCredits ? "default" : "pointer", opacity: outOfCredits ? 0.4 : 1 }}
                  >
                    ✦ Draft a blueprint
                  </button>
                  <button
                    type="button"
                    className="iqa-sugg"
                    disabled={outOfCredits || visionBusy}
                    onClick={() => fileRef.current?.click()}
                    style={{ borderRadius: 999, border: `1px solid ${T.hairline}`, background: "transparent", padding: "9px 17px", fontFamily: SANS, fontSize: 13.5, color: T.muted, cursor: outOfCredits || visionBusy ? "default" : "pointer", opacity: outOfCredits || visionBusy ? 0.4 : 1 }}
                  >
                    {visionBusy ? "Reading the chart…" : "⧉ Generate from image"}
                  </button>
                </div>
              )}

              <div style={{ marginTop: 24, display: "flex", gap: 9, flexWrap: "wrap", justifyContent: "center" }}>
                {copy.pills.map((p) => (
                  <button
                    key={p}
                    type="button"
                    disabled={outOfCredits}
                    onClick={() => submitStart(p)}
                    className="iqa-sugg"
                    style={{
                      borderRadius: 999,
                      border: `1px solid ${T.hairline}`,
                      background: "transparent",
                      padding: "9px 17px",
                      fontFamily: SANS,
                      fontSize: 13.5,
                      color: T.muted,
                      cursor: outOfCredits ? "default" : "pointer",
                      opacity: outOfCredits ? 0.4 : 1,
                      transition: "color .2s ease, border-color .2s ease",
                    }}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ position: "absolute", bottom: 20, left: 0, right: 0, textAlign: "center", fontFamily: MONO, fontSize: 10, letterSpacing: "0.12em", color: T.ghost }}>
              {creditsLeft ?? "—"} CREDITS · RESETS DAILY · NOT FINANCIAL ADVICE
            </div>
            {brainOpen && assistant === "pine" && (
              <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", width: 760, maxWidth: "calc(100% - 40px)", bottom: 60, height: 0 }}>
                <BrainstormPanel
                  ticker={ticker}
                  seed={draftA}
                  onSpec={openSpec}
                  onClose={() => setBrainOpen(false)}
                  onError={(m) => toast(T.bear, m)}
                />
              </div>
            )}
          </main>
        ) : (
          <main style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            {/* 4.1 contact header — CHART CHATS ONLY: it carries the live
                price, the read status and the alert switch. Pine and Coach
                chats skip it entirely (the sidebar names the assistant, the
                sidebar row menu deletes the chat) — every vertical pixel
                goes to the workspace. */}
            {active.assistant === "chart" && (
            <div style={{ padding: "13px 22px", borderBottom: `1px solid ${T.hairlineSoft}`, display: "flex", alignItems: "center", gap: 13, flexShrink: 0 }}>
              <Avatar sym={active.sym ?? "?"} read={activeRead} />
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 700, color: T.ink }}>{active.sym}</span>
                  {activeRead && (
                    <span style={{ fontFamily: SANS, fontSize: 15, fontWeight: 500, color: T.muted }}>{fmtPrice(activeRead.price)}</span>
                  )}
                </div>
                <div style={{ marginTop: 2, fontFamily: SANS, fontSize: 12, color: readColor(activeRead), whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  {activeRead ? statusLine(activeRead) : "read refreshing — next scan will reground this chat"}
                </div>
              </div>
              <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0 }}>
                {active.armed ? (
                  <QuietPill onClick={toggleAlert}>Disable alert</QuietPill>
                ) : (
                  <QuietPill solid onClick={toggleAlert}>Enable alert</QuietPill>
                )}
                <QuietPill
                  onClick={() =>
                    setConfirm({
                      title: "Delete this chat?",
                      action: "Delete",
                      run: () => {
                        persist(loadChats().filter((c) => c.id !== active.id));
                        goStart();
                      },
                    })
                  }
                >
                  ⋯
                </QuietPill>
              </div>
            </div>
            )}

            {/* the desk splits: chat column + (pine only) the workspace.
                In pine the CHAT is the fixed-width sidekick and the
                chart/code workspace takes every remaining pixel — the
                LuxAlgo proportions. */}
            <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <div
              className="iqa-chatcol"
              style={
                active.assistant === "pine"
                  ? { flex: "0 0 440px", width: 440, minWidth: 0, display: "flex", flexDirection: "column", position: "relative", borderRight: `1px solid ${T.hairlineSoft}` }
                  : { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", position: "relative" }
              }
            >
            {/* 4.2 thread */}
            <div ref={threadRef} onScroll={onThreadScroll} role="log" aria-live="polite" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "24px 22px", display: "flex", flexDirection: "column", gap: 12, position: "relative" }}>
              <Divider
                label={
                  active.assistant === "chart"
                    ? `TODAY · GROUNDED IN SCAN ${active.scanTag}`
                    : active.assistant === "pine"
                      ? "TODAY · PINE V6 WORKSPACE"
                      : "TODAY · PRIVATE TO YOU"
                }
              />
              {active.messages.map((m, i) => {
                if (m.role !== "ai") return <UserBubble key={i} m={m} />;
                if (active.assistant === "pine") {
                  if (m.kind === "spec" && m.spec) {
                    return <SpecCard key={i} m={m} busy={busy} onChip={(c) => onSpecChip(active.id, m.spec!, c)} />;
                  }
                  const { prose, code } = splitPine(m.text);
                  if (code) {
                    /* the bubble stays conversational; the script lives in the
                       rail (desktop) or the inline block (narrow screens) */
                    const shown = prose || "Here is the script.";
                    return (
                      <div key={i} style={{ display: "contents" }}>
                        <AiBubble m={{ ...m, text: shown, chips: ["PINE V6 · SCRIPT READY"] }} tag="IQ PINE COPILOT" />
                        <InlineScript code={code} />
                      </div>
                    );
                  }
                  const choices = parsePineChoices(m.text);
                  if (choices) {
                    const live = i === active.messages.length - 1 && !busy;
                    return (
                      <PineChoiceBubble
                        key={i}
                        m={m}
                        choices={choices}
                        live={live}
                        onPick={(q) => sendInChat(active.id, q)}
                        onOther={() => { const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>("[data-iqa-composer]"); el?.focus(); }}
                      />
                    );
                  }
                  return <AiBubble key={i} m={m} tag="IQ PINE COPILOT" />;
                }
                if (active.assistant === "coach") return <AiBubble key={i} m={m} tag="IQ TRADING COACH" />;
                const snap = m.setup ?? ((m.kind === "setup" || isSetupText(m.text)) ? activeSnap ?? undefined : undefined);
                return snap ? (
                  <SetupBubble key={i} m={{ ...m, setup: snap }} bars={activeBars.data} />
                ) : (
                  <AiBubble key={i} m={m} />
                );
              })}
              {busy && <TypingBubble />}
            </div>
            {showJump && (
              <button
                type="button"
                aria-label="Jump to latest"
                onClick={() => {
                  const el = threadRef.current;
                  if (el) el.scrollTop = el.scrollHeight;
                  setShowJump(false);
                }}
                style={{ position: "absolute", right: 38, bottom: 110, width: 32, height: 32, borderRadius: "50%", background: T.panel, border: `1px solid ${T.hairline}`, color: T.muted, cursor: "pointer", zIndex: 30 }}
              >
                ↓
              </button>
            )}

            {brainOpen && active.assistant === "pine" && (
              <BrainstormPanel
                ticker={active.sym ?? ticker}
                seed={draftB}
                onSpec={openSpec}
                onClose={() => setBrainOpen(false)}
                onError={(m) => toast(T.bear, m)}
              />
            )}

            <div style={{ padding: "13px 22px 16px", borderTop: `1px solid ${T.hairlineSoft}`, flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                {active.assistant === "pine" && (
                  <>
                    <button
                      type="button"
                      aria-label="Draft a blueprint"
                      title="Draft a blueprint"
                      disabled={outOfCredits}
                      onClick={() => setBrainOpen((v) => !v)}
                      style={{ width: 38, height: 38, flexShrink: 0, borderRadius: "50%", border: `1px solid ${T.accentBorder}`, background: T.accentTint, color: T.accentLt, fontSize: 14, cursor: outOfCredits ? "default" : "pointer", opacity: outOfCredits ? 0.4 : 1 }}
                    >
                      ✦
                    </button>
                    <button
                      type="button"
                      aria-label="Generate from image"
                      title="Generate from image"
                      disabled={outOfCredits || visionBusy}
                      onClick={() => fileRef.current?.click()}
                      style={{ width: 38, height: 38, flexShrink: 0, borderRadius: "50%", border: `1px solid ${T.hairline}`, background: "transparent", color: T.muted, fontSize: 14, cursor: outOfCredits || visionBusy ? "default" : "pointer", opacity: outOfCredits || visionBusy ? 0.4 : 1 }}
                    >
                      ⧉
                    </button>
                  </>
                )}
                <input
                  data-iqa-composer-b
                  value={draftB}
                  onChange={(e) => setDraftB(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (draftB.trim() && !outOfCredits) sendInChat(active.id, draftB);
                    }
                  }}
                  disabled={outOfCredits}
                  placeholder={
                    outOfCredits
                      ? "Out of credits — resets at midnight"
                      : active.assistant === "chart"
                        ? `Message ${active.sym}'s analyst…`
                        : active.assistant === "pine"
                          ? "Describe the indicator or alert…"
                          : "Describe the habit or the trade…"
                  }
                  style={{
                    flex: 1,
                    borderRadius: 999,
                    border: "1px solid var(--iq-line)",
                    background: T.raised,
                    padding: "12px 18px",
                    fontFamily: SANS,
                    fontSize: 14.5,
                    color: T.ink,
                    opacity: outOfCredits ? 0.4 : 1,
                  }}
                />
                {outOfCredits && (
                  <Link to="/topup" className="iqa-primary" style={{ borderRadius: 999, padding: "9px 16px", background: T.accent, color: "#fff", fontFamily: SANS, fontSize: 12.5, fontWeight: 700, textDecoration: "none", whiteSpace: "nowrap" }}>
                    Top up
                  </Link>
                )}
                <SendCircle size={42} disabled={!draftB.trim() || outOfCredits} onClick={() => sendInChat(active.id, draftB)} />
              </div>
              <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 9.5, letterSpacing: "0.1em", color: T.ghost }}>
                <span>1 CREDIT PER QUESTION</span>
                <span>{active.assistant === "chart" ? "ANSWERS CITE THE SCAN" : active.assistant === "pine" ? "SCRIPTS SHIP HOUSE-STYLED" : "PROCESS, NOT PICKS"}</span>
              </div>
            </div>
            </div>
            {active.assistant === "pine" && <PineWorkbench latest={latestScript(active.messages)} chatId={active.id} linked={linked} onSaved={onSaved} onBacktest={() => openBacktestFor(linked?.id ?? null)} />}
            </div>
          </main>
        )}
      </div>

      <Toasts items={toasts} />
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: "none" }}
        onChange={(e) => void onPickImage(e.target.files?.[0])}
      />
      {confirm && (
        <ConfirmModal
          title={confirm.title}
          action={confirm.action}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run();
            setConfirm(null);
          }}
        />
      )}
    </div>
  );
}
