// THT canonical data backbone — public GitHub Pages endpoints.
// Open CORS, no auth, no SDK. Plain fetch + JSON.

const BASE = "https://piraci26.github.io/tht-data";

export const RESULTS_DAILY = `${BASE}/results.json`;
export const RESULTS_WEEKLY = `${BASE}/results_weekly.json`;
export const RESULTS_MONTHLY = `${BASE}/results_monthly.json`;
export const ARTICLES = `${BASE}/articles.json`;
export const AI_READS = "https://piraci26.github.io/iq-data/ai/reads.json";
export const IQ_SCAN = "https://piraci26.github.io/iq-data/iq/scan.json";
export const IQ_SIGNALS = "https://piraci26.github.io/iq-data/iq/signals.json";
export const IQ_SIGNALS_SWING = "https://piraci26.github.io/iq-data/iq/signals_swing.json";
export const IQ_SCREENER = "https://piraci26.github.io/iq-data/iq/screener.json";

export const SECTORS = `${BASE}/universe_sectors.json`;
export const ATH_ATL = `${BASE}/ath_atl_cache.json`;

export const BARS_DAILY = (sym: string) => `${BASE}/bars/${sym}.json`;
export const BARS_WEEKLY = (sym: string) => `${BASE}/bars_weekly/${sym}.json`;
export const BARS_MONTHLY = (sym: string) => `${BASE}/bars_monthly/${sym}.json`;

// ---------- Types ----------

export type Timeframe = "daily" | "weekly" | "monthly";

export interface ScanRow {
  sym: string;
  name: string;
  mcap: number | null;
  price: number;
  basis: number;
  bxt_today: number | null;
  bxt_yest: number | null;
  fvb_g: boolean;
  fvb_r: boolean;
  bxt_g: boolean;
  bxt_r: boolean;
  fvb_streak: number | null;
  bxt_streak: number | null;
  ath: number | null;
  pct_to_ath: number | null;
}

export interface ScanChanges {
  compared_to: string;
  fvb_green_added: string[];
  fvb_green_removed: string[];
  fvb_red_added: string[];
  fvb_red_removed: string[];
  bxt_green_added: string[];
  bxt_green_removed: string[];
  bxt_red_added: string[];
  bxt_red_removed: string[];
}

export interface ScanResults {
  updated_at: string;
  timeframe: Timeframe;
  scan_seconds: number;
  scanned_count: number;
  fvb_green: ScanRow[];
  fvb_red: ScanRow[];
  bxt_green: ScanRow[];
  bxt_red: ScanRow[];
  changes: ScanChanges;
}

export interface Bar {
  /** Unix timestamp in seconds (lightweight-charts UTCTimestamp). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Article {
  slug: string;
  title: string;
  date: string;
  summary?: string;
  url?: string;
  [k: string]: unknown;
}

export interface AiRead {
  read: string;
  updated_at: string;
  state_hash: string;
}

/** Keyed by bare ticker symbol, e.g. "MSFT". */
export type AiReads = Record<string, AiRead>;

export interface IqScanTicker {
  name: string;
  mcap: number | null;
  price: number;
  /** Per-timeframe engine payloads (daily/weekly/monthly) — loosely typed for now. */
  d?: any;
  w?: any;
  m?: any;
}

export interface IqScan {
  updated_at: string;
  /** Keyed by bare ticker symbol, e.g. "MSFT". */
  tickers: Record<string, IqScanTicker>;
}

// ---------- Fetcher ----------

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`THT fetch failed ${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

// ---------- Typed fetchers ----------

export const fetchResultsDaily = (signal?: AbortSignal) =>
  getJSON<ScanResults>(RESULTS_DAILY, signal);
export const fetchResultsWeekly = (signal?: AbortSignal) =>
  getJSON<ScanResults>(RESULTS_WEEKLY, signal);
export const fetchResultsMonthly = (signal?: AbortSignal) =>
  getJSON<ScanResults>(RESULTS_MONTHLY, signal);

export const fetchBarsDaily = (sym: string, signal?: AbortSignal) =>
  getJSON<Bar[]>(BARS_DAILY(sym), signal);
export const fetchBarsWeekly = (sym: string, signal?: AbortSignal) =>
  getJSON<Bar[]>(BARS_WEEKLY(sym), signal);
export const fetchBarsMonthly = (sym: string, signal?: AbortSignal) =>
  getJSON<Bar[]>(BARS_MONTHLY(sym), signal);

export const fetchArticles = (signal?: AbortSignal) =>
  getJSON<Article[]>(ARTICLES, signal);

export const fetchAiReads = (signal?: AbortSignal) =>
  getJSON<AiReads>(AI_READS, signal);

export const fetchIqScan = (signal?: AbortSignal) =>
  getJSON<IqScan>(IQ_SCAN, signal);

export type TripleTf = {
  regime: "bull" | "bear";
  age: number | null;
  flipped: boolean;
  flip_at?: string | null;
  close?: number;
  wave_side?: string;
  flow_side?: string;
  confluence?: number;
};

export type TripleSignal = {
  sym: string;
  name: string;
  side: "bull" | "bear";
  price: number | null;
  fresh: boolean;
  youngest_tf: string;
  youngest_age: number;
  completed_at?: string | null;
  tfs: { m30: TripleTf; h2: TripleTf; d: TripleTf };
};

export type IqSignals = {
  updated_at: string;
  universe: number;
  checked: number;
  failed: number;
  count: number;
  bull: number;
  bear: number;
  triples: TripleSignal[];
};

export const fetchIqSignals = (signal?: AbortSignal) =>
  getJSON<IqSignals>(IQ_SIGNALS, signal);

/** The SWING set — same document shape, legs 2H / 1D / W. */
export type SwingTripleSignal = Omit<TripleSignal, "tfs"> & {
  tfs: { h2: TripleTf; d: TripleTf; w: TripleTf };
};
export type IqSwingSignals = Omit<IqSignals, "triples"> & { triples: SwingTripleSignal[] };

export const fetchIqSwingSignals = (signal?: AbortSignal) =>
  getJSON<IqSwingSignals>(IQ_SIGNALS_SWING, signal);

/** 1-minute bars — chart feed for the Signals workstation and the Pine
 * workbench. PER-SYMBOL files (a bare array of compact [t, o, h, l, c, v]
 * rows, ~30KB each) covering every symbol on either signals book plus the
 * top caps; a 404 means "not covered today". The one-file bundle was 18MB
 * — never ship that to a browser. */
export const IQ_BARS_1M = (sym: string) =>
  `https://piraci26.github.io/iq-data/iq/bars_1m/${sym}.json`;

export type Rows1m = [number, number, number, number, number, number][];

export const fetchIqBars1m = (sym: string, signal?: AbortSignal) =>
  getJSON<Rows1m>(IQ_BARS_1M(sym), signal);

export const IQ_BARS_5M = (sym: string) =>
  `https://piraci26.github.io/iq-data/iq/bars_5m/${sym}.json`;
export const fetchIqBars5m = (sym: string, signal?: AbortSignal) =>
  getJSON<Rows1m>(IQ_BARS_5M(sym), signal);
/** 60 days of 5-minute rows, written once per session by the pipeline. */
export const iqBars5mQuery = (sym: string) => ({
  queryKey: ["iq", "bars5m", sym] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIqBars5m(sym, signal),
  staleTime: 30 * 60_000,
  enabled: !!sym,
});

export const iqBars1mQuery = (sym: string) => ({
  queryKey: ["iq", "bars1m", sym] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIqBars1m(sym, signal),
  staleTime: 5 * 60_000,
  enabled: !!sym,
});

/** Compact 1m rows → the Bar shape every chart consumes. */
export const rows1mToBars = (rows: Rows1m): Bar[] =>
  rows.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));

export type ScreenerTfState = {
  regime: "bull" | "bear";
  age: number | null;
  flip: boolean;
  basis_pct: number | null;
  vol_z: number | null;
  hv: string | null;
  noise: string | null;
  wave_side: string | null;
  wave_rel: string | null;
  flow: string | null;
  conf: number | null;
};

export type ScreenerRow = {
  sym: string;
  name: string | null;
  mcap: number | null;
  price: number | null;
  /** 1-day % change between the last two confirmed closes (feed ≥ 2026-08-30). */
  chg1d?: number | null;
  d?: ScreenerTfState;
  w?: ScreenerTfState;
  m?: ScreenerTfState;
  struct_events?: string[];
};

export type IqScreener = {
  updated_at: string;
  count: number;
  rows: ScreenerRow[];
};

export const fetchIqScreener = (signal?: AbortSignal) =>
  getJSON<IqScreener>(IQ_SCREENER, signal);

/** S&P 500 membership (dash-normalized tickers, e.g. BRK-B). */
export const IQ_SP500 = "https://piraci26.github.io/iq-data/iq/sp500.json";
export type Sp500 = { updated_at: string; count: number; tickers: string[] };
export const fetchSp500 = (signal?: AbortSignal) => getJSON<Sp500>(IQ_SP500, signal);
export const sp500Query = () => ({
  queryKey: ["iq", "sp500"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchSp500(signal),
  staleTime: 24 * 3600_000,
});

/** Keyed by bare symbol; sector/industry from stockanalysis profiles. */
export type SectorMap = Record<string, { sector: string | null; industry: string | null } | null>;
export const fetchSectors = (signal?: AbortSignal) => getJSON<SectorMap>(SECTORS, signal);

/** results[SYM] = [ath, atl, wk52h, wk52l, ath30d, atl30d, lastHigh, lastLow, lastClose, madeAthToday, madeAtlToday] */
export interface AthAtlCache {
  updated_at: string;
  results: Record<string, (number | boolean)[]>;
}
export const fetchAthAtl = (signal?: AbortSignal) => getJSON<AthAtlCache>(ATH_ATL, signal);

// ---------- TanStack Query options ----------

export const SCAN_STALE_MS = 60_000;
export const SCAN_REFETCH_MS = 300_000;

export const resultsDailyQuery = () => ({
  queryKey: ["tht", "results", "daily"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchResultsDaily(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const resultsWeeklyQuery = () => ({
  queryKey: ["tht", "results", "weekly"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchResultsWeekly(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const resultsMonthlyQuery = () => ({
  queryKey: ["tht", "results", "monthly"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchResultsMonthly(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const sectorsQuery = () => ({
  queryKey: ["tht", "sectors"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchSectors(signal),
  staleTime: 24 * 3600_000,
});

export const athAtlQuery = () => ({
  queryKey: ["tht", "athatl"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchAthAtl(signal),
  staleTime: 30 * 60_000,
});

export const barsDailyQuery = (sym: string) => ({
  queryKey: ["tht", "bars", "daily", sym] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchBarsDaily(sym, signal),
  staleTime: SCAN_STALE_MS,
  enabled: !!sym,
});

export const barsWeeklyQuery = (sym: string) => ({
  queryKey: ["tht", "bars", "weekly", sym] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchBarsWeekly(sym, signal),
  staleTime: SCAN_STALE_MS,
  enabled: !!sym,
});

export const barsMonthlyQuery = (sym: string) => ({
  queryKey: ["tht", "bars", "monthly", sym] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchBarsMonthly(sym, signal),
  staleTime: SCAN_STALE_MS,
  enabled: !!sym,
});

export const articlesQuery = () => ({
  queryKey: ["tht", "articles"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchArticles(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const aiReadsQuery = () => ({
  queryKey: ["tht", "reads"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchAiReads(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const iqSignalsQuery = () => ({
  queryKey: ["tht", "signals"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIqSignals(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const iqSwingSignalsQuery = () => ({
  queryKey: ["tht", "signals-swing"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIqSwingSignals(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

export const iqScreenerQuery = () => ({
  queryKey: ["tht", "screener"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIqScreener(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});



export const iqScanQuery = () => ({
  queryKey: ["iq", "scan"] as const,
  queryFn: ({ signal }: { signal?: AbortSignal }) => fetchIqScan(signal),
  staleTime: SCAN_STALE_MS,
  refetchInterval: SCAN_REFETCH_MS,
});

// ---------- Helpers ----------

/** Merge all four buckets into one row-per-ticker list with dual-flip status. */
export interface UnifiedRow extends ScanRow {
  fvb_status: "green" | "red" | null;
  bxt_status: "green" | "red" | null;
  /** "dual-green" when both green, "dual-red" when both red, else "mixed" or "single". */
  dual: "dual-green" | "dual-red" | "mixed" | "single";
}

export function unifyResults(r: ScanResults): UnifiedRow[] {
  const map = new Map<string, UnifiedRow>();
  const put = (
    row: ScanRow,
    fvb: UnifiedRow["fvb_status"],
    bxt: UnifiedRow["bxt_status"],
  ) => {
    const existing = map.get(row.sym);
    const merged: UnifiedRow = {
      ...(existing ?? row),
      fvb_status: existing?.fvb_status ?? fvb,
      bxt_status: existing?.bxt_status ?? bxt,
      dual: "single",
    };
    if (fvb && existing?.fvb_status == null) merged.fvb_status = fvb;
    if (bxt && existing?.bxt_status == null) merged.bxt_status = bxt;
    map.set(row.sym, merged);
  };
  r.fvb_green.forEach((row) => put(row, "green", null));
  r.fvb_red.forEach((row) => put(row, "red", null));
  r.bxt_green.forEach((row) => put(row, null, "green"));
  r.bxt_red.forEach((row) => put(row, null, "red"));

  for (const row of map.values()) {
    if (row.fvb_status === "green" && row.bxt_status === "green") row.dual = "dual-green";
    else if (row.fvb_status === "red" && row.bxt_status === "red") row.dual = "dual-red";
    else if (row.fvb_status && row.bxt_status) row.dual = "mixed";
    else row.dual = "single";
  }
  return [...map.values()];
}
