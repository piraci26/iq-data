/* Proves the trades read behind the site's flow edge function against the real Alpaca
   API with the repo's keys: a whole session of one symbol folded into one-minute
   slices of volume at price, the cost in requests and seconds, and the session as a
   one-day artifact (the fixture the footprint is built on). */
import { mkdirSync, writeFileSync } from "node:fs";
import { extendSession, newSession } from "./alpacaTrades.ts";

const keyId = process.env.ALPACA_KEY_ID ?? "";
const secret = process.env.ALPACA_SECRET_KEY ?? "";
if (!keyId || !secret) { console.error("ALPACA_KEY_ID / ALPACA_SECRET_KEY missing"); process.exit(2); }
const symbols = (process.env.SYMBOLS ?? "NVDA").split(/\s+/).filter(Boolean);
const day = process.env.DAY ?? "2026-10-09";
mkdirSync("out", { recursive: true });

for (const sym of symbols) {
  const s = newSession(sym, day);
  const t0 = Date.now();
  let requests = 0;
  let rounds = 0;
  try {
    /* the function's own budget per call, round after round, as the desk would ask */
    while (!s.whole && rounds < 40) {
      const r = await extendSession(s, { keyId, secret }, 25_000, Date.now());
      requests += r.requests;
      rounds++;
      console.log(`  round ${rounds}: +${r.added} trades, ${r.requests} requests, upTo ${new Date(s.upTo * 1000).toISOString().slice(11, 19)}Z, whole ${s.whole}`);
      if (r.requests === 0 && !s.whole) break;
    }
    const levels = s.slices.reduce((a, x) => a + x.l.length, 0);
    const buy = s.slices.reduce((a, x) => a + x.l.reduce((b, r) => b + r[1], 0), 0);
    const sell = s.slices.reduce((a, x) => a + x.l.reduce((b, r) => b + r[2], 0), 0);
    const big = s.slices.reduce((a, x) => a + x.big.length, 0);
    const json = JSON.stringify(s);
    console.log(`\n${sym} ${day}: ${s.trades} trades · ${s.slices.length} minutes · ${levels} price levels · ${requests} requests · ${((Date.now() - t0) / 1000).toFixed(1)} s · ${rounds} rounds`);
    console.log(`  volume ${Math.round(buy + sell)} (buy ${Math.round(buy)}, sell ${Math.round(sell)}, delta ${Math.round(buy - sell)}) · big prints ${big} · ${(json.length / 1024).toFixed(0)} KB`);
    const mid = s.slices[Math.floor(s.slices.length / 2)];
    if (mid) console.log(`  ${new Date(mid.t * 1000).toISOString().slice(11, 16)}Z: ${mid.l.length} levels, ${mid.l.slice(0, 4).map((r) => r.join("/")).join(" ")} … big ${mid.big.map((b) => b.join("/")).join(" ")}`);
    writeFileSync(`out/${sym}-${day}.json`, json);
  } catch (e) {
    console.error(`${sym}: FAILED`, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
