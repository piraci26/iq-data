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
export type Stats = { requests: number; pages: number; raw: number; bars: number; sessions: number; ms: number };

export type AlpacaErrorCode = "refused" | "rate_limited" | "upstream" | "bad_request";
export class AlpacaError extends Error {
  code: AlpacaErrorCode;
  constructor(code: AlpacaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const DATA = "https://data.alpaca.markets/v2/stocks";
/* a chunk stays under one 10,000-bar page even with pre-market and after-hours
   bars in it (up to ~960 one-minute bars a weekday), so chunks run side by side */
const CHUNK_DAYS: Record<Tf, number> = { "1Min": 10, "5Min": 50 };
const PARALLEL = 6;
/* the free plan refuses the newest 15 minutes of the consolidated tape */
const DELAY_MS = 16 * 60_000;
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
function nyClock(ms: number): { day: number; min: number } {
  const local = ms + nyOffsetMin(Math.floor(ms / DAY_MS)) * 60_000;
  return { day: Math.floor(local / DAY_MS), min: Math.floor((local % DAY_MS) / 60_000) };
}

const isWeekday = (day: number) => { const w = (day + 4) % 7; return w >= 1 && w <= 5; }; // 1970-01-01 was a Thursday
const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

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

/** The newest `sessions` regular sessions of `sym`, oldest first, up to 16 minutes ago. */
export async function deepBars(opts: { sym: string; tf: Tf; sessions: number; keyId: string; secret: string; now?: number; fetchImpl?: typeof fetch }): Promise<{ rows: Row[]; stats: Stats }> {
  const t0 = Date.now();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stats: Stats = { requests: 0, pages: 0, raw: 0, bars: 0, sessions: 0, ms: 0 };
  const end = (opts.now ?? Date.now()) - DELAY_MS;
  /* weekdays back from today, with room for holidays */
  const want = opts.sessions + Math.ceil(opts.sessions / 20) + 2;
  const days: number[] = [];
  for (let d = nyClock(end).day; days.length < want; d--) if (isWeekday(d)) days.unshift(d);
  const chunks: { start: string; end: string }[] = [];
  for (let i = 0; i < days.length; i += CHUNK_DAYS[opts.tf]) {
    const next = days[i + CHUNK_DAYS[opts.tf]];
    chunks.push({
      start: `${isoDay(days[i])}T00:00:00Z`,
      end: next === undefined ? new Date(end).toISOString() : `${isoDay(next)}T00:00:00Z`,
    });
  }
  const byTime = new Map<number, Row>();
  const fetchChunk = async (c: { start: string; end: string }) => {
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ timeframe: opts.tf, start: c.start, end: c.end, limit: "10000", adjustment: "split", feed: "sip", sort: "asc" });
      if (token) q.set("page_token", token);
      const page = await getPage(`${DATA}/${encodeURIComponent(opts.sym)}/bars?${q}`, opts.keyId, opts.secret, fetchImpl, stats);
      stats.raw += page.bars.length;
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
  let rows = [...byTime.values()].sort((a, b) => a[0] - b[0]);
  /* keep the newest `sessions` days that traded */
  const sessionDays: number[] = [];
  for (const r of rows) { const d = nyClock(r[0] * 1000).day; if (sessionDays[sessionDays.length - 1] !== d) sessionDays.push(d); }
  if (sessionDays.length > opts.sessions) {
    const first = sessionDays[sessionDays.length - opts.sessions];
    rows = rows.filter((r) => nyClock(r[0] * 1000).day >= first);
  }
  stats.bars = rows.length;
  stats.sessions = Math.min(sessionDays.length, opts.sessions);
  stats.ms = Date.now() - t0;
  return { rows, stats };
}
