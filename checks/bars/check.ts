/* Runs the site's bars edge-function core (checks/bars/alpacaBars.ts is a copy of
   trend-iq supabase/functions/bars/alpacaBars.ts; update both) against the real
   Alpaca API and prints what one chart load costs: requests, bars, sessions, time,
   payload size. Rows are kept in out/ for a day as an artifact for chart tests. */
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dailyFrom30, deepBars } from "./alpacaBars.ts";

const keyId = process.env.ALPACA_KEY_ID ?? "";
const secret = process.env.ALPACA_SECRET_KEY ?? "";
const syms = (process.env.SYMBOLS ?? "NVDA SPY").split(/\s+/).filter(Boolean);
/* 30Min x 520 is the bars function's tf=1Day ask (a name outside the scan's daily files):
   its regular-session half hours folded into days */
const plan: [("1Min" | "5Min" | "30Min"), number][] = [["1Min", 120], ["5Min", 600], ["30Min", 520]];
mkdirSync("out", { recursive: true });
const at = (s: number) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ");
for (const sym of syms) {
  for (const [tf, sessions] of plan) {
    try {
      const { rows, stats } = await deepBars({ sym, tf, sessions, keyId, secret });
      const body = JSON.stringify({ sym, tf, sessions: stats.sessions, rows });
      console.log(`${sym} ${tf} x${sessions}: ${JSON.stringify(stats)} | ${at(rows[0][0])} -> ${at(rows[rows.length - 1][0])} UTC | ${(body.length / 1e6).toFixed(2)} MB, gzip ${(gzipSync(body).length / 1e6).toFixed(2)} MB`);
      writeFileSync(`out/${sym}_${tf}.json`, body);
      if (tf === "30Min") {
        const days = dailyFrom30(rows);
        const day = (r: number[]) => new Date(r[0] * 1000).toISOString().slice(0, 10);
        console.log(`${sym} 1Day (from 30Min): ${days.length} days | ${day(days[0])} -> ${day(days[days.length - 1])} | last close ${days[days.length - 1][4]}`);
        writeFileSync(`out/${sym}_1Day.json`, JSON.stringify({ sym, tf: "1Day", rows: days }));
      }
    } catch (e) {
      console.log(`${sym} ${tf}: FAILED ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
  }
}
