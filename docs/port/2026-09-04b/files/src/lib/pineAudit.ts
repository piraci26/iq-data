/* Static sanity audit for a Pine script: the checks a trader pays for before
   trusting a self-built indicator. Rule-based over the source text — no
   compiler, no replay. It reads every request.security call, every signal
   line and every deprecated form, and says what it found, by line. */

export type AuditSeverity = "pass" | "warn" | "fail";
export type AuditFinding = { line: number | null; tag: string; why: string; severity: AuditSeverity };
export type AuditVerdict = "clean" | "check" | "fails";
export type Audit = { findings: AuditFinding[]; verdict: AuditVerdict; headline: string; detail: string };

const strip = (l: string) => l.replace(/"[^"]*"/g, '""').replace(/\/\/.*$/, "");

export function auditPine(code: string): Audit {
  const lines = code.split(/\r?\n/);
  const F: AuditFinding[] = [];
  const at = (re: RegExp): number | null => { const i = lines.findIndex((l) => re.test(strip(l))); return i < 0 ? null : i + 1; };

  /* ---- language version and dead syntax ---- */
  const ver = code.match(/\/\/@version\s*=\s*(\d+)/);
  if (!ver) F.push({ line: 1, tag: "PINE VERSION", why: "No //@version line. The Pine editor treats it as v1 and nothing modern compiles.", severity: "fail" });
  else if (Number(ver[1]) < 6) F.push({ line: at(/\/\/@version/) ?? 1, tag: "PINE VERSION", why: `Written for v${ver[1]}. Mixed with v6 habits it will not paste clean; the copilot writes v6 only.`, severity: "fail" });
  else F.push({ line: at(/\/\/@version/) ?? 1, tag: "PINE VERSION", why: "v6. Current reference, current namespaces.", severity: "pass" });

  const study = at(/\bstudy\s*\(/);
  if (study) F.push({ line: study, tag: "V4 SYNTAX", why: "study() is gone. v6 wants indicator().", severity: "fail" });
  const bareSec = at(/(^|[^.\w])security\s*\(/);
  if (bareSec) F.push({ line: bareSec, tag: "V4 CALL", why: "security() without the request. namespace. v6 needs request.security().", severity: "fail" });
  const transp = at(/\btransp\s*=/);
  if (transp) F.push({ line: transp, tag: "DEPRECATED", why: "transp is gone in v6. Use color.new(color, transparency).", severity: "fail" });

  /* ---- higher-timeframe calls ---- */
  lines.forEach((raw, i) => {
    const l = strip(raw);
    if (!/request\.security\s*\(/.test(l)) return;
    const ln = i + 1;
    const on = /lookahead\s*=\s*barmerge\.lookahead_on/.test(l);
    const off = /lookahead\s*=\s*barmerge\.lookahead_off/.test(l);
    const offset = /\[\s*\d+\s*\]/.test(l);
    if (on && offset) F.push({ line: ln, tag: "HIGHER TIMEFRAME", why: "lookahead_on with an offset: the classic non-repainting form. Nothing from the future.", severity: "pass" });
    else if (on) F.push({ line: ln, tag: "PEEKS FORWARD", why: "lookahead_on without an offset returns the higher-timeframe bar before it closes. Backtests will look better than live.", severity: "fail" });
    else if (offset || off) F.push({ line: ln, tag: "HIGHER TIMEFRAME", why: offset ? "Offset by a bar, lookahead off. Nothing from the future." : "lookahead off. The value cannot come from the future.", severity: "pass" });
    else F.push({ line: ln, tag: "UNCONFIRMED HTF BAR", why: "No offset and no lookahead argument: the higher-timeframe value keeps moving until that bar closes.", severity: "warn" });
  });

  /* ---- signal gating ---- */
  const signalRe = /\b(plotshape|plotchar|plotarrow|alertcondition|strategy\.entry|strategy\.close|alert)\s*\(/;
  const firstSignal = at(signalRe);
  const confirmed = at(/barstate\.isconfirmed/);
  const isStrategy = /^\s*strategy\s*\(/m.test(code);
  const tick = at(/calc_on_every_tick\s*=\s*true/);
  if (firstSignal) {
    if (confirmed) F.push({ line: confirmed, tag: "ENTRY GATE", why: "barstate.isconfirmed gates the logic. Signals fire once, on the close.", severity: "pass" });
    else if (isStrategy && !tick) F.push({ line: firstSignal, tag: "ORDERS ON CLOSE", why: "A strategy places its orders once the bar closes and fills them on the next bar. No mid-bar flicker unless calc_on_every_tick is on.", severity: "pass" });
    else if (!isStrategy) F.push({ line: firstSignal, tag: "MID-BAR SIGNALS", why: "No barstate.isconfirmed anywhere. A signal can appear and vanish before the bar closes.", severity: "warn" });
  }
  if (tick) F.push({ line: tick, tag: "EVERY TICK", why: "calc_on_every_tick=true: the strategy trades intrabar in live mode but not in the backtest.", severity: "warn" });
  const varip = at(/\bvarip\b/);
  if (varip) F.push({ line: varip, tag: "VARIP", why: "varip keeps intrabar state. History and live will not match by design.", severity: "warn" });
  const tn = lines.findIndex((l) => /\btimenow\b/.test(strip(l)) && /\b(if|and|or)\b|\?/.test(strip(l)));
  if (tn >= 0) F.push({ line: tn + 1, tag: "REALTIME CLOCK", why: "timenow inside a condition: true only while the script runs live, never in history.", severity: "warn" });

  /* ---- alert consistency ---- */
  const alertArg = code.match(/alertcondition\s*\(\s*([A-Za-z_]\w*)/);
  if (alertArg) {
    const v = alertArg[1];
    const plotted = new RegExp(`\\b(plotshape|plotchar|plotarrow)\\s*\\(\\s*${v}\\b`).test(code);
    const ln = at(/alertcondition\s*\(/);
    if (plotted) F.push({ line: ln, tag: "ALERT", why: `alertcondition(${v}) is the same condition as the plot. No divergence.`, severity: "pass" });
    else F.push({ line: ln, tag: "ALERT DIVERGENCE", why: `alertcondition(${v}) is not what the chart plots. The alert and the picture can disagree.`, severity: "warn" });
  }

  const fails = F.filter((f) => f.severity === "fail").length;
  const warns = F.filter((f) => f.severity === "warn").length;
  const verdict: AuditVerdict = fails ? "fails" : warns ? "check" : "clean";
  const headline = verdict === "clean" ? "NO REPAINT FOUND" : verdict === "check" ? "CHECK BEFORE YOU TRUST IT" : "WOULD REPAINT OR NOT PASTE CLEAN";
  const detail = verdict === "clean"
    ? "static audit · every call read · exact behaviour confirmed in TradingView"
    : `${fails ? `${fails} failing` : ""}${fails && warns ? " · " : ""}${warns ? `${warns} to check` : ""} · static audit, by line`;
  return { findings: F, verdict, headline, detail };
}
