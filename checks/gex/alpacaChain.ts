/* An option chain from Alpaca: open interest from the trading API's contracts, implied
   vol, greeks and the day's volume from the market data chain snapshots, spot from the
   stock snapshot. Plain TypeScript on fetch: the site's gex edge function runs it on
   Deno, and the check here runs the same file on Node against the real API.

   Owner, 2026-10-10 ("I'd like to be able to analyse GEX for each stock"): the plan
   agreed that day, no new data source, the keys the bars function already has. */

export type ChainRow = {
  /** the OCC symbol, e.g. NVDA260612C00215000 */
  sym: string;
  type: "C" | "P";
  strike: number;
  /** YYYY-MM-DD */
  expiry: string;
  /** open interest, as of oiDate (end of the previous session, every provider) */
  oi: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  /** the day's contracts traded */
  vol: number;
  bid: number | null;
  ask: number | null;
};

export type Chain = {
  underlying: string;
  spot: number;
  /** ISO time of the spot trade */
  spotAt: string | null;
  /** the open interest date the contracts carry (YYYY-MM-DD), the latest seen */
  oiDate: string | null;
  rows: ChainRow[];
  stats: { requests: number; contracts: number; snapshots: number; joined: number; ms: number; tradingHost: string };
};

export type AlpacaErrorCode = "refused" | "rate_limited" | "upstream" | "bad_request";
export class AlpacaError extends Error {
  code: AlpacaErrorCode;
  constructor(code: AlpacaErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const DATA = "https://data.alpaca.markets";
/* the contracts endpoint is on the trading API, whose host depends on the account the
   keys belong to: a paper key pair answers only on the paper host, a live one on the
   live host. Both are tried; the one that answers is remembered for the process. */
const TRADING_HOSTS = ["https://paper-api.alpaca.markets", "https://api.alpaca.markets"];
let tradingHost: string | null = null;

type Keys = { keyId: string; secret: string };

async function get(url: string, keys: Keys, counter: { requests: number }): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    counter.requests++;
    const res = await fetch(url, { headers: { "APCA-API-KEY-ID": keys.keyId, "APCA-API-SECRET-KEY": keys.secret, accept: "application/json" } });
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new AlpacaError("refused", `alpaca ${res.status}: ${text}`);
    if (res.status === 400 || res.status === 404 || res.status === 422) throw new AlpacaError("bad_request", `alpaca ${res.status}: ${text}`);
    if (res.status === 429 && attempt < 4) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    if (res.status === 429) throw new AlpacaError("rate_limited", `alpaca 429: ${text}`);
    if (attempt < 2) { await new Promise((r) => setTimeout(r, 800)); continue; }
    throw new AlpacaError("upstream", `alpaca ${res.status}: ${text}`);
  }
}

type Contract = { symbol: string; type: "call" | "put"; strike_price: string; expiration_date: string; open_interest?: string | null; open_interest_date?: string | null; status?: string };
type Snapshot = {
  latestQuote?: { bp?: number; ap?: number } | null;
  impliedVolatility?: number | null;
  greeks?: { delta?: number; gamma?: number } | null;
  dailyBar?: { v?: number } | null;
};

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** every listed contract of the underlying expiring within `days`, with open interest */
async function contracts(underlying: string, days: number, keys: Keys, counter: { requests: number }): Promise<{ list: Contract[]; host: string }> {
  const hosts = tradingHost ? [tradingHost] : TRADING_HOSTS;
  let lastErr: unknown = null;
  for (const host of hosts) {
    try {
      const list: Contract[] = [];
      let token: string | null = null;
      do {
        const u = new URL(`${host}/v2/options/contracts`);
        u.searchParams.set("underlying_symbols", underlying);
        u.searchParams.set("status", "active");
        u.searchParams.set("expiration_date_gte", isoDay(Date.now() - 86_400_000));
        u.searchParams.set("expiration_date_lte", isoDay(Date.now() + days * 86_400_000));
        u.searchParams.set("limit", "10000");
        if (token) u.searchParams.set("page_token", token);
        const page = (await get(u.toString(), keys, counter)) as { option_contracts?: Contract[]; next_page_token?: string | null };
        list.push(...(page.option_contracts ?? []));
        token = page.next_page_token ?? null;
      } while (token);
      tradingHost = host;
      return { list, host };
    } catch (e) {
      lastErr = e;
      if (!(e instanceof AlpacaError && e.code === "refused")) throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new AlpacaError("refused", "no trading host answered");
}

/** the chain snapshots: implied vol, greeks, quotes and the day's bar per contract */
async function snapshots(underlying: string, days: number, keys: Keys, counter: { requests: number }): Promise<Record<string, Snapshot>> {
  const out: Record<string, Snapshot> = {};
  let token: string | null = null;
  do {
    const u = new URL(`${DATA}/v1beta1/options/snapshots/${underlying}`);
    u.searchParams.set("feed", "indicative");
    u.searchParams.set("limit", "1000");
    u.searchParams.set("expiration_date_lte", isoDay(Date.now() + days * 86_400_000));
    if (token) u.searchParams.set("page_token", token);
    const page = (await get(u.toString(), keys, counter)) as { snapshots?: Record<string, Snapshot>; next_page_token?: string | null };
    Object.assign(out, page.snapshots ?? {});
    token = page.next_page_token ?? null;
  } while (token);
  return out;
}

/** the underlying's latest trade (IEX, real time on the free plan) */
async function spotOf(underlying: string, keys: Keys, counter: { requests: number }): Promise<{ p: number; t: string | null }> {
  const u = `${DATA}/v2/stocks/${underlying}/trades/latest?feed=iex`;
  const j = (await get(u, keys, counter)) as { trade?: { p?: number; t?: string } };
  const p = j.trade?.p;
  if (!p) throw new AlpacaError("upstream", "no spot trade");
  return { p, t: j.trade?.t ?? null };
}

/** the chain, joined: a row per contract that has open interest or a snapshot */
export async function fetchChain(underlying: string, keys: Keys, days = 400): Promise<Chain> {
  const t0 = Date.now();
  const counter = { requests: 0 };
  const [{ list, host }, snaps, spot] = await Promise.all([
    contracts(underlying, days, keys, counter),
    snapshots(underlying, days, keys, counter),
    spotOf(underlying, keys, counter),
  ]);
  const rows: ChainRow[] = [];
  let oiDate: string | null = null;
  let joined = 0;
  for (const c of list) {
    const s = snaps[c.symbol];
    const oi = Number(c.open_interest ?? 0) || 0;
    if (s) joined++;
    if (!s && !oi) continue;
    if (c.open_interest_date && (!oiDate || c.open_interest_date > oiDate)) oiDate = c.open_interest_date;
    rows.push({
      sym: c.symbol,
      type: c.type === "call" ? "C" : "P",
      strike: Number(c.strike_price),
      expiry: c.expiration_date,
      oi,
      iv: s?.impliedVolatility ?? null,
      delta: s?.greeks?.delta ?? null,
      gamma: s?.greeks?.gamma ?? null,
      vol: s?.dailyBar?.v ?? 0,
      bid: s?.latestQuote?.bp ?? null,
      ask: s?.latestQuote?.ap ?? null,
    });
  }
  rows.sort((a, b) => (a.expiry < b.expiry ? -1 : a.expiry > b.expiry ? 1 : a.strike - b.strike || (a.type < b.type ? -1 : 1)));
  return {
    underlying,
    spot: spot.p,
    spotAt: spot.t,
    oiDate,
    rows,
    stats: { requests: counter.requests, contracts: list.length, snapshots: Object.keys(snaps).length, joined, ms: Date.now() - t0, tradingHost: host },
  };
}
