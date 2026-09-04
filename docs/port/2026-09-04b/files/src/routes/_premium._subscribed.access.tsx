import { createFileRoute, Link } from "@tanstack/react-router";
import { useAuthSession } from "@/hooks/useAuthSession";
import { INDICATORS, type IndicatorDef } from "@/lib/indicators";

export const Route = createFileRoute("/_premium/_subscribed/access")({
  head: () => ({
    meta: [
      { title: "TradingView Access — Alpha Charts" },
      { name: "description", content: "The five instruments in the Alpha Charts suite, their access status, and how to get them on a chart." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: IndicatorsPage,
});

type Status = "GRANTED" | "PENDING" | "LOCKED";

const APP_GRADIENT = "var(--iq-bg)";

function IndicatorsPage() {
  const { isPremium } = useAuthSession();
  // TODO: real per-indicator status from backend
  const tvUsername = "Jakub_Kaszynski";

  return (
    <div style={{ position: "relative", background: APP_GRADIENT, minHeight: "calc(100dvh - 200px)" }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, top: 0, height: 380, pointerEvents: "none", background: "radial-gradient(95% 65% at 50% -8%, rgba(61,105,168,0.28), rgba(61,105,168,0.09) 36%, transparent 66%)" }} />
      <main className="mx-auto" style={{ position: "relative", maxWidth: 1180, padding: "32px 64px 64px" }}>
        <p style={{ fontSize: 11, letterSpacing: "0.16em", color: "var(--iq-faint)", fontWeight: 600, margin: 0 }}>THE SUITE</p>
        <h1 style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 600, fontSize: 36, color: "var(--iq-ink)", margin: "8px 0 0" }}>
          Five instruments, one read
        </h1>
        <p style={{ marginTop: 12, color: "var(--iq-muted)", fontSize: 15, lineHeight: 1.55, maxWidth: 740 }}>
          Every script is invite-only on TradingView and granted to{" "}
          <span style={{ color: "var(--iq-ink)", fontWeight: 600 }}>{tvUsername}</span>. Change the username in{" "}
          <Link to="/account" style={{ color: "var(--iq-steel)", textDecoration: "underline" }}>Account</Link>.
        </p>

        <div className="iq-ind-grid" style={{ marginTop: 32, display: "grid", gap: 18, gridTemplateColumns: "repeat(3, 1fr)" }}>
          {INDICATORS.map((ind) => (
            <IndicatorCard key={ind.key} ind={ind} status={isPremium ? "GRANTED" : "LOCKED"} />
          ))}
        </div>
      </main>
      <style>{`
        @media (max-width: 1024px) { .iq-ind-grid { grid-template-columns: repeat(2, 1fr) !important; } }
        @media (max-width: 768px) { .iq-ind-grid { grid-template-columns: 1fr !important; } }
      `}</style>
    </div>
  );
}

function IndicatorCard({ ind, status }: { ind: IndicatorDef; status: Status }) {
  return (
    <article style={{
      /* a real card in both themes: token surface + hairline, not a white alpha
         that disappears on the light background */
      background: "var(--iq-card)", border: "1px solid var(--iq-line)", borderRadius: 14, padding: 22,
      boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
      display: "flex", flexDirection: "column", gap: 14, transition: "border-color .15s, box-shadow .15s",
    }} onMouseEnter={(e) => { e.currentTarget.style.borderColor = "rgba(61,105,168,0.45)"; e.currentTarget.style.boxShadow = "0 8px 24px rgba(15,23,42,0.08)"; }} onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--iq-line)"; e.currentTarget.style.boxShadow = "0 1px 2px rgba(15,23,42,0.04)"; }}>
      <div className="flex items-center justify-between">
        <div aria-hidden style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(61,105,168,0.12)", border: "1px solid rgba(61,105,168,0.25)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--iq-steel)" }}>
          <IndIcon k={ind.key} />
        </div>
        <StatusChip status={status} />
      </div>
      <div>
        <h2 style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 600, fontSize: 17, color: "var(--iq-ink)", margin: 0 }}>{ind.name}</h2>
        <p style={{ fontSize: 13, color: "var(--iq-faint)", margin: "6px 0 0", lineHeight: 1.5 }}>{ind.oneLiner}</p>
      </div>
      <MiniStrip kind={ind.key} />
      <div className="flex items-center justify-between" style={{ marginTop: "auto", paddingTop: 6, fontSize: 12.5 }}>
        {status === "LOCKED" ? (
          <Link to="/pricing" style={{ color: "var(--iq-steel)", fontWeight: 600 }}>Unlock →</Link>
        ) : (
          <a href={ind.tvHref} target="_blank" rel="noreferrer" style={{ color: "var(--iq-steel)", fontWeight: 600 }}>Add to chart ↗</a>
        )}
        <a href={ind.guideHref} style={{ color: "var(--iq-faint)" }}>Guide</a>
      </div>
    </article>
  );
}

function StatusChip({ status }: { status: Status }) {
  const map = {
    GRANTED: { bg: "rgba(47,191,143,0.16)", color: "#089981", border: "rgba(47,191,143,0.35)", label: "✓ GRANTED" },
    PENDING: { bg: "rgba(224,169,74,0.16)", color: "#e0a94a", border: "rgba(224,169,74,0.35)", label: "PENDING" },
    LOCKED: { bg: "var(--iq-surface)", color: "var(--iq-muted)", border: "var(--iq-line)", label: "LOCKED" },
  }[status];
  return (
    <span style={{
      padding: "4px 9px", borderRadius: 6, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
      background: map.bg, color: map.color, border: `1px solid ${map.border}`,
    }}>{map.label}</span>
  );
}

function MiniStrip({ kind }: { kind: IndicatorDef["key"] }) {
  return (
    <div aria-hidden style={{ height: 44, background: "var(--iq-surface)", border: "1px solid var(--iq-line)", borderRadius: 8, overflow: "hidden" }}>
      <svg width="100%" height="44" viewBox="0 0 280 44" preserveAspectRatio="none">
        {kind === "bands" && (<>
          <path d="M0,12 Q70,4 140,14 T280,10" stroke="var(--iq-steel)" strokeWidth="1" fill="none" opacity="0.6" />
          <path d="M0,32 Q70,40 140,30 T280,34" stroke="var(--iq-steel)" strokeWidth="1" fill="none" opacity="0.6" />
          <path d="M0,22 Q70,18 140,24 T280,22" stroke="#3D69A8" strokeWidth="1.6" fill="none" />
        </>)}
        {kind === "oscillator" && Array.from({ length: 22 }).map((_, i) => {
          const h = Math.abs(Math.sin(i * 0.55)) * 16 + 2;
          const pos = i % 4 < 2;
          return <rect key={i} x={i * 13 + 4} y={pos ? 22 - h : 22} width={9} height={h} fill={pos ? "#089981" : "#F23645"} opacity="0.7" />;
        })}
        {kind === "structure" && (<>
          <rect x="12" y="6" width="70" height="9" fill="#F23645" opacity="0.18" stroke="#F23645" strokeWidth="0.8" />
          <rect x="170" y="29" width="76" height="9" fill="#089981" opacity="0.18" stroke="#089981" strokeWidth="0.8" />
          <line x1="120" y1="13" x2="196" y2="13" stroke="var(--iq-steel)" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
          <path d="M0,36 L40,22 L70,30 L120,13 L156,26 L200,9 L236,19 L280,5" stroke="#3D69A8" strokeWidth="1.6" fill="none" />
        </>)}
      </svg>
    </div>
  );
}

function IndIcon({ k }: { k: IndicatorDef["key"] }) {
  const s = { width: 18, height: 18 } as const;
  switch (k) {
    case "bands": return <svg {...s} viewBox="0 0 24 24" fill="none"><path d="M3 8 Q12 2 21 8 M3 16 Q12 22 21 16" stroke="currentColor" strokeWidth="1.6" /></svg>;
    case "oscillator": return <svg {...s} viewBox="0 0 24 24" fill="none"><rect x="3" y="10" width="3" height="8" fill="currentColor" /><rect x="8" y="6" width="3" height="12" fill="currentColor" /><rect x="13" y="12" width="3" height="6" fill="currentColor" /><rect x="18" y="4" width="3" height="14" fill="currentColor" /></svg>;
    case "structure": return <svg {...s} viewBox="0 0 24 24" fill="none"><path d="M3 18 L8 12 L12 15 L17 8 L21 11" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><rect x="4" y="4" width="7" height="4" stroke="currentColor" strokeWidth="1.2" /></svg>;
  }
}
