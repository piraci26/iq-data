/* Order flow from real trades, phase 2 (owner, 2026-10-11/12: "the way luxalgo did",
   "phase 2"): a symbol's trades for one New York session from Alpaca's consolidated
   tape (every US exchange, the free plan 15 minutes behind), each trade given a side by
   the tick rule, and the lot folded into one-minute slices of volume at price with the
   buying and selling split and the trade counts, plus the largest trades of each
   minute. The desk re-buckets the slices to any bar and any row height.

   Plain TypeScript on fetch: the flow edge function runs it on Deno, and the iq-data
   check runs the same file on Node against the real API. A session is built in time
   windows so a call can stop inside a budget and the next call carries on. */

export type AlpacaErrorCode = "refused" | "rate_limited" | "upstream" | "bad_request";
export class AlpacaError extends Error {
  code: AlpacaErrorCode;
  constructor(code: AlpacaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const DATA = "https://data.alpaca.markets";
/* the free plan refuses the newest 15 minutes of the consolidated tape */
export const DELAY_MS = 16 * 60_000;
const PAGE = 10_000;

type Keys = { keyId: string; secret: string };
type Trade = { t: string; p: number; s: number; c?: string[]; x?: string };

/** one minute of a session: price levels with buying and selling, and the big trades */
export type Slice = {
  /** unix seconds of the minute's start */
  t: number;
  /** [price, buy volume, sell volume, buy trades, sell trades], by price ascending */
  l: [number, number, number, number, number][];
  /** the largest trades: [price, size, side 1 buy / -1 sell], biggest first, up to five */
  big: [number, number, number][];
};

export type Session = {
  v: 1;
  sym: string;
  /** YYYY-MM-DD, New York */
  day: string;
  /** the session's bounds, unix seconds (09:30 and 16:00 New York) */
  open: number;
  close: number;
  /** trades are folded in up to here (unix seconds); the session is whole when it is the close */
  upTo: number;
  whole: boolean;
  slices: Slice[];
  trades: number;
  /** the tick rule's memory across windows: the last price and the last non-zero tick */
  tick: { last: number; dir: number } | null;
  /** the last folded trade's timestamp (RFC-3339, nanoseconds): the next read starts one nanosecond after it */
  after: string | null;
  source: "alpaca";
  asOf: string;
};

/* New York's offset for a UTC day, by the US rule since 2007 */
const DAY_MS = 86_400_000;
const nthSunday = (y: number, m: number, n: number) => 1 + ((7 - new Date(Date.UTC(y, m, 1)).getUTCDay()) % 7) + (n - 1) * 7;
export function nyOffsetMin(ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  const dst = ms >= Date.UTC(y, 2, nthSunday(y, 2, 2), 7) && ms < Date.UTC(y, 10, nthSunday(y, 10, 1), 6);
  return dst ? -240 : -300;
}
/** the session's open and close in unix seconds for a New York day */
export function sessionBounds(day: string): { open: number; close: number } {
  const noonUtc = Date.parse(`${day}T12:00:00Z`);
  const off = nyOffsetMin(noonUtc);
  const open = (Date.parse(`${day}T09:30:00Z`) - off * 60_000) / 1000;
  const close = (Date.parse(`${day}T16:00:00Z`) - off * 60_000) / 1000;
  return { open, close };
}

async function get(url: string, keys: Keys, counter: { requests: number }): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    counter.requests++;
    const res = await fetch(url, { headers: { "APCA-API-KEY-ID": keys.keyId, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" } });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new AlpacaError("refused", `alpaca ${res.status}: ${text}`);
    if (res.status === 400 || res.status === 422) throw new AlpacaError("bad_request", `alpaca ${res.status}: ${text}`);
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
      continue;
    }
    if (res.status === 429) throw new AlpacaError("rate_limited", `alpaca 429: ${text}`);
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 700));
      continue;
    }
    throw new AlpacaError("upstream", `alpaca ${res.status}: ${text}`);
  }
}

/* conditions that are not a lot traded in the session's flow: cash, next-day, seller's
   option, odd lots keep (they are volume), out-of-sequence and prior-reference prints
   are kept for volume but excluded from the tick rule (their price is stale) */
const STALE = new Set(["Z", "P", "U", "L"]);

/** an RFC-3339 timestamp one nanosecond later ("…00.123456789Z" → "…00.123456790Z") */
export function plusOneNs(iso: string): string {
  const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?Z$/.exec(iso);
  if (!m) return iso;
  const frac = (m[2] ?? "").padEnd(9, "0").slice(0, 9);
  let n = Number(frac) + 1;
  let secs = m[1];
  if (n >= 1_000_000_000) {
    n = 0;
    secs = new Date(Date.parse(`${m[1]}Z`) + 1000).toISOString().slice(0, 19);
  }
  return `${secs}.${String(n).padStart(9, "0")}Z`;
}

/** an empty session shell for a day */
export function newSession(sym: string, day: string): Session {
  const { open, close } = sessionBounds(day);
  return { v: 1, sym, day, open, close, upTo: open, whole: false, slices: [], trades: 0, tick: null, after: null, source: "alpaca", asOf: new Date().toISOString() };
}

/** folds the session's trades from `upTo` towards the close, stopping once `budgetMs` has
 *  passed or the delayed edge of the tape is reached; returns the requests it made */
export async function extendSession(s: Session, keys: Keys, budgetMs: number, now = Date.now()): Promise<{ requests: number; added: number }> {
  const counter = { requests: 0 };
  const edge = Math.min(s.close, Math.floor((now - DELAY_MS) / 1000));
  if (s.whole || s.upTo >= edge) {
    if (s.upTo >= s.close) s.whole = true;
    return { requests: 0, added: 0 };
  }
  const t0 = Date.now();
  /* slices by minute for quick folding */
  const byMin = new Map<number, Slice>();
  for (const sl of s.slices) byMin.set(sl.t, sl);
  const levels = new Map<number, Map<number, [number, number, number, number, number]>>();
  let added = 0;
  let tick = s.tick ? { ...s.tick } : null;
  let cursor = s.upTo;
  let after = s.after;
  /* windows of 30 minutes, each paged; a window read whole moves upTo to its end, a
     window cut by the budget resumes one nanosecond after its last folded trade */
  while (cursor < edge && Date.now() - t0 < budgetMs) {
    const wEnd = Math.min(edge, cursor + 30 * 60);
    let token: string | null = null;
    let cut = false;
    do {
      const u = new URL(`${DATA}/v2/stocks/${encodeURIComponent(s.sym)}/trades`);
      u.searchParams.set("start", after ? plusOneNs(after) : new Date(cursor * 1000).toISOString());
      u.searchParams.set("end", new Date(wEnd * 1000).toISOString());
      u.searchParams.set("limit", String(PAGE));
      u.searchParams.set("feed", "sip");
      u.searchParams.set("sort", "asc");
      if (token) u.searchParams.set("page_token", token);
      const page = (await get(u.toString(), keys, counter)) as { trades?: Trade[]; next_page_token?: string | null };
      const list = page.trades ?? [];
      for (const tr of list) {
        const ms = Date.parse(tr.t);
        const sec = Math.floor(ms / 1000);
        if (sec < s.open || sec >= s.close) continue;
        const stale = (tr.c ?? []).some((c) => STALE.has(c));
        /* the tick rule: above the last price buys, below sells, the same inherits the
           last tick; a stale print inherits too; the first trade, with nothing to
           compare, splits half each way */
        let side = 0;
        if (!stale) {
          if (tick) {
            if (tr.p > tick.last) side = 1;
            else if (tr.p < tick.last) side = -1;
            else side = tick.dir;
            tick = { last: tr.p, dir: side || tick.dir };
          } else tick = { last: tr.p, dir: 0 };
        } else side = tick?.dir ?? 0;
        const minute = sec - (sec % 60);
        let sl = byMin.get(minute);
        if (!sl) {
          sl = { t: minute, l: [], big: [] };
          byMin.set(minute, sl);
        }
        let lv = levels.get(minute);
        if (!lv) {
          lv = new Map(sl.l.map((row) => [row[0], row]));
          levels.set(minute, lv);
        }
        const price = Math.round(tr.p * 100) / 100;
        let row = lv.get(price);
        if (!row) {
          row = [price, 0, 0, 0, 0];
          lv.set(price, row);
          sl.l.push(row);
        }
        const size = tr.s;
        if (side > 0) {
          row[1] += size;
          row[3] += 1;
        } else if (side < 0) {
          row[2] += size;
          row[4] += 1;
        } else {
          row[1] += size / 2;
          row[2] += size / 2;
          row[3] += 0.5;
          row[4] += 0.5;
        }
        if (size >= 1000) {
          sl.big.push([price, size, side]);
          if (sl.big.length > 12) {
            sl.big.sort((a, b) => b[1] - a[1]);
            sl.big.length = 5;
          }
        }
        added++;
        after = tr.t;
      }
      token = page.next_page_token ?? null;
      if (token && Date.now() - t0 >= budgetMs * 1.5) {
        cut = true;
        break;
      }
    } while (token);
    if (cut) {
      /* the budget ran out inside the window: everything folded so far stays, the next
         call resumes after the last trade */
      cursor = after ? Math.floor(Date.parse(after) / 1000) : cursor;
      break;
    }
    cursor = wEnd;
  }
  for (const sl of byMin.values()) {
    sl.l.sort((a, b) => a[0] - b[0]);
    for (const row of sl.l) {
      row[1] = Math.round(row[1]);
      row[2] = Math.round(row[2]);
      row[3] = Math.round(row[3]);
      row[4] = Math.round(row[4]);
    }
    sl.big.sort((a, b) => b[1] - a[1]);
    if (sl.big.length > 5) sl.big.length = 5;
  }
  s.slices = [...byMin.values()].sort((a, b) => a.t - b.t);
  s.trades += added;
  s.tick = tick;
  s.after = after;
  s.upTo = cursor;
  s.whole = s.upTo >= s.close;
  s.asOf = new Date().toISOString();
  return { requests: counter.requests, added };
}
