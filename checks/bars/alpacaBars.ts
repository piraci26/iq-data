/* Deep intraday history from Alpaca's market data API, regular session only.

   Owner, 2026-09-17: the charts need "10 times more historic bars to the left"
   on 1 and 5 minutes. That is 120 one-minute and 600 five-minute sessions,
   about 47,000 bars either way. For every name the charts cover that would be
   about 3 GB of files, three times the GitHub Pages limit, so the deep part is
   asked of Alpaca when a chart opens.

   Plain TypeScript on fetch and Date: the bars edge function runs it on Deno,
   and a check runs the same file on Node against the real API. */

export type Tf = "1Min" | "5Min";
/** [unix seconds, open, high, low, close, volume] — the rows the iq-data files use */
export type Row = [number, number, number, number, number, number];
export type Stats = { requests: number; pages: number; raw: number; bars: number; sessions: number; ms: number; cachedMonths?: number };

export type AlpacaErrorCode = "refused" | "rate_limited" | "upstream" | "bad_request";
export class AlpacaError extends Error {
  code: AlpacaErrorCode;
  constructor(code: AlpacaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const DATA = "https://data.alpaca.markets/v2/stocks";
/* one page a request either way, so the requests run side by side: a 1-minute
   page holds 10,000 bars, ten weekdays with pre-market and after-hours; a
   5-minute page holds about 1,900 (Alpaca counts the minutes under them), nine */
const CHUNK_DAYS: Record<Tf, number> = { "1Min": 10, "5Min": 9 };
const PARALLEL = 12;
/* the free plan refuses the newest 15 minutes of the consolidated tape */
export const DELAY_MS = 16 * 60_000;
const DAY_MS = 86_400_000;

/* New York's UTC offset for a UTC day, by the US rule since 2007 (daylight time
   from the second Sunday of March to the first Sunday of November, switching at
   2am local). A regular session, 13:30–21:00 UTC, never straddles a switch. */
const offsets = new Map<number, number>();
const nthSunday = (y: number, m: number, n: number) => 1 + ((7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7) + (n - 1) * 7;
function nyOffsetMin(utcDay: number): number {
  let off = offsets.get(utcDay);
  if (off === undefined) {
    const noon = utcDay * DAY_MS + 15 * 3_600_000;
    const y = new Date(noon).getUTCFullYear();
    const dst = noon >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && noon < Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
    off = dst ? -240 : -300;
    offsets.set(utcDay, off);
  }
  return off;
}

/** the New York calendar day (days since 1970-01-01) and minute of that day */
export function nyClock(ms: number): { day: number; min: number } {
  const local = ms + nyOffsetMin(Math.floor(ms / DAY_MS)) * 60_000;
  return { day: Math.floor(local / DAY_MS), min: Math.floor((local % DAY_MS) / 60_000) };
}
export const isWeekday = (day: number) => { const w = (day + 4) % 7; return w >= 1 && w <= 5; }; // 1970-01-01 was a Thursday
export const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
/** "YYYY-MM" of a New York day */
export const monthOf = (day: number) => isoDay(day).slice(0, 7);
export const rowDay = (r: Row) => nyClock(r[0] * 1000).day;

/** weekdays, oldest first, far enough back to hold `sessions` sessions despite holidays */
export function planDays(sessions: number, endMs: number): number[] {
  const want = sessions + Math.ceil(sessions / 20) + 2;
  const days: number[] = [];
  for (let d = nyClock(endMs).day; days.length < want; d--) if (isWeekday(d)) days.unshift(d);
  return days;
}

/** every weekday from the first of `month` through `lastDay` */
export function weekdaysFrom(month: string, lastDay: number): number[] {
  const out: number[] = [];
  for (let d = Math.floor(Date.parse(`${month}-01T00:00:00Z`) / DAY_MS); d <= lastDay; d++) if (isWeekday(d)) out.push(d);
  return out;
}

type AlpacaBar = { t: string; o: number; h: number; l: number; c: number; v: number };

async function getPage(url: string, keyId: string, secret: string, fetchImpl: typeof fetch, stats: Stats): Promise<{ bars: AlpacaBar[]; next: string | null }> {
  for (let attempt = 0; ; attempt++) {
    stats.requests++;
    const res = await fetchImpl(url, { headers: { "APCA-API-KEY-ID": keyId, "APCA-API-SECRET-KEY": secret, Accept: "application/json" } });
    if (res.ok) {
      const body = (await res.json()) as { bars?: AlpacaBar[] | null; next_page_token?: string | null };
      stats.pages++;
      return { bars: body.bars ?? [], next: body.next_page_token ?? null };
    }
    const text = (await res.text().catch(() => "")).slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new AlpacaError("refused", `alpaca ${res.status}: ${text}`);
    if (res.status === 400 || res.status === 404 || res.status === 422) throw new AlpacaError("bad_request", `alpaca ${res.status}: ${text}`);
    if (attempt >= 3) throw new AlpacaError(res.status === 429 ? "rate_limited" : "upstream", `alpaca ${res.status}: ${text}`);
    const wait = Number(res.headers.get("retry-after")) * 1000 || 1200 * (attempt + 1);
    await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
  }
}

export type FetchOpts = { sym: string; tf: Tf; keyId: string; secret: string; endMs: number; fetchImpl?: typeof fetch; stats: Stats };

/** Regular-session bars for the given weekdays (ascending, gaps allowed), oldest first. */
export async function fetchDays(days: number[], o: FetchOpts): Promise<Row[]> {
  const fetchImpl = o.fetchImpl ?? fetch;
  /* runs of consecutive weekdays, cut every CHUNK_DAYS */
  const chunks: { start: string; end: string }[] = [];
  let run: number[] = [];
  const close = () => {
    if (!run.length) return;
    const endMs = Math.min(o.endMs, (run[run.length - 1] + 1) * DAY_MS);
    if (run[0] * DAY_MS < endMs) chunks.push({ start: `${isoDay(run[0])}T00:00:00Z`, end: new Date(endMs).toISOString() });
    run = [];
  };
  for (const d of days) {
    const prev = run[run.length - 1];
    if (run.length >= CHUNK_DAYS[o.tf] || (prev !== undefined && d - prev > 3)) close(); // more than a weekend apart: a new run
    run.push(d);
  }
  close();
  const byTime = new Map<number, Row>();
  const fetchChunk = async (c: { start: string; end: string }) => {
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ timeframe: o.tf, start: c.start, end: c.end, limit: "10000", adjustment: "split", feed: "sip", sort: "asc" });
      if (token) q.set("page_token", token);
      const page = await getPage(`${DATA}/${encodeURIComponent(o.sym)}/bars?${q}`, o.keyId, o.secret, fetchImpl, o.stats);
      o.stats.raw += page.bars.length;
      for (const b of page.bars) {
        const ms = Date.parse(b.t);
        const { day, min } = nyClock(ms);
        if (min < 570 || min >= 960 || !isWeekday(day)) continue; // 09:30–16:00 New York
        byTime.set(ms / 1000, [ms / 1000, b.o, b.h, b.l, b.c, b.v]);
      }
      token = page.next;
    } while (token);
  };
  for (let i = 0; i < chunks.length; i += PARALLEL) await Promise.all(chunks.slice(i, i + PARALLEL).map(fetchChunk));
  return [...byTime.values()].sort((a, b) => a[0] - b[0]);
}

/** the newest `sessions` days that traded */
export function lastSessions(rows: Row[], sessions: number): { rows: Row[]; sessions: number } {
  const days: number[] = [];
  for (const r of rows) { const d = rowDay(r); if (days[days.length - 1] !== d) days.push(d); }
  if (days.length <= sessions) return { rows, sessions: days.length };
  const first = days[days.length - sessions];
  return { rows: rows.filter((r) => rowDay(r) >= first), sessions };
}

export const newStats = (): Stats => ({ requests: 0, pages: 0, raw: 0, bars: 0, sessions: 0, ms: 0 });

/** The newest `sessions` regular sessions of `sym`, oldest first, up to 16 minutes ago, straight from Alpaca. */
export async function deepBars(opts: { sym: string; tf: Tf; sessions: number; keyId: string; secret: string; now?: number; fetchImpl?: typeof fetch }): Promise<{ rows: Row[]; stats: Stats }> {
  const t0 = Date.now();
  const stats = newStats();
  const endMs = (opts.now ?? Date.now()) - DELAY_MS;
  const all = await fetchDays(planDays(opts.sessions, endMs), { ...opts, endMs, stats });
  const out = lastSessions(all, opts.sessions);
  stats.bars = out.rows.length;
  stats.sessions = out.sessions;
  stats.ms = Date.now() - t0;
  return { rows: out.rows, stats };
}
