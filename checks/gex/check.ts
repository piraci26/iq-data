/* Proves the option-chain read behind the site's gex edge function against the real
   Alpaca API with the repo's keys: counts, what the rows carry, the cost, and the
   chain itself as a one-day artifact (the fixture the site's panel is built on). */
import { mkdirSync, writeFileSync } from "node:fs";
import { fetchChain } from "./alpacaChain.ts";

const keyId = process.env.ALPACA_KEY_ID ?? "";
const secret = process.env.ALPACA_SECRET_KEY ?? "";
if (!keyId || !secret) { console.error("ALPACA_KEY_ID / ALPACA_SECRET_KEY missing"); process.exit(2); }
const symbols = (process.env.SYMBOLS ?? "NVDA").split(/\s+/).filter(Boolean);
mkdirSync("out", { recursive: true });

for (const sym of symbols) {
  try {
    const chain = await fetchChain(sym, { keyId, secret });
    const r = chain.rows;
    const withOi = r.filter((x) => x.oi > 0).length;
    const withGreeks = r.filter((x) => x.gamma != null && x.delta != null).length;
    const withIv = r.filter((x) => x.iv != null).length;
    const withVol = r.filter((x) => x.vol > 0).length;
    const expiries = [...new Set(r.map((x) => x.expiry))];
    const oiTotal = r.reduce((a, x) => a + x.oi, 0);
    console.log(`\n${sym}: spot ${chain.spot} at ${chain.spotAt} · OI date ${chain.oiDate}`);
    console.log(`  requests ${chain.stats.requests} · ${chain.stats.ms} ms · trading host ${chain.stats.tradingHost}`);
    console.log(`  contracts ${chain.stats.contracts} · snapshots ${chain.stats.snapshots} · joined ${chain.stats.joined} · rows kept ${r.length}`);
    console.log(`  rows with OI ${withOi} (total OI ${oiTotal}) · with greeks ${withGreeks} · with IV ${withIv} · with volume ${withVol}`);
    console.log(`  expiries ${expiries.length}: ${expiries.slice(0, 12).join(" ")}${expiries.length > 12 ? " …" : ""}`);
    const near = r.filter((x) => x.expiry === expiries[0] && Math.abs(x.strike - chain.spot) < chain.spot * 0.03);
    for (const x of near.slice(0, 8)) console.log(`  ${x.sym} ${x.type} ${x.strike} oi ${x.oi} vol ${x.vol} iv ${x.iv?.toFixed(3)} δ ${x.delta?.toFixed(3)} γ ${x.gamma?.toFixed(4)} ${x.bid}/${x.ask}`);
    writeFileSync(`out/${sym}-chain.json`, JSON.stringify(chain));
    console.log(`  wrote out/${sym}-chain.json (${(JSON.stringify(chain).length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    console.error(`${sym}: FAILED`, e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
