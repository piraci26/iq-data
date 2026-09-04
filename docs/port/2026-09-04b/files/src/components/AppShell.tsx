import { Link } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { iqScreenerQuery } from "@/lib/tht-api";
import { useAuthSession } from "@/hooks/useAuthSession";
import { claimReferral } from "@/lib/affiliate.functions";
import { SiteNav } from "@/components/iq/SiteNav";
import { SiteFooter } from "@/components/SiteFooter";
import { LAB_LABEL } from "@/lib/labLabel";

/**
 * Member area shell.
 * Renders the shared marketing nav on top of a dark page, then a lightweight
 * sub-tab bar for member routes, then the page content, then the shared footer.
 * Design system: dark #050505, DM Sans, IBM Plex Mono, blue #3D69A8 accent only.
 */

const TABS = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/analyst", label: "IQ Analyst" },
  { to: "/quant", label: LAB_LABEL },
  { to: "/screener", label: "Screener" },
  { to: "/signals", label: "Signals" },
  { to: "/tape", label: "Live Tape" },
  { to: "/access", label: "Indicators" },
  { to: "/guide", label: "Guide" },
] as const;

/* the account pill goes straight to the account page (owner 2026-09-04:
   no dropdown, no Account tab; sign-out lives on the account page and in
   the nav) */
function AccountLink() {
  return (
    <Link
      to="/account"
      activeOptions={{ exact: false }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px 6px 8px",
        borderRadius: 999,
        border: "1px solid var(--iq-line)",
        background: "var(--iq-card)",
        color: "var(--iq-ink)",
        fontSize: 12.5,
        fontFamily: "'IBM Plex Mono', monospace",
        textDecoration: "none",
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "rgba(61,105,168,.18)",
          border: "1px solid rgba(61,105,168,.3)",
          display: "inline-block",
        }}
        aria-hidden
      />
      Account
    </Link>
  );
}

function ScanChip() {
  const { data } = useQuery({ ...iqScreenerQuery(), staleTime: 120_000 });
  if (!data?.updated_at) return null;
  const d = new Date(data.updated_at);
  const p = (x: number) => String(x).padStart(2, "0");
  return (
    <span
      style={{
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10.5,
        letterSpacing: "0.14em",
        color: "var(--iq-steel)",
        whiteSpace: "nowrap",
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
      }}
    >
      <style>{`@keyframes iqScanPulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }`}</style>
      <span
        aria-hidden
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "#3D69A8",
          boxShadow: "0 0 8px rgba(61,105,168,.9)",
          animation: "iqScanPulse 1.6s ease-in-out infinite",
        }}
      />
      SCAN {p(d.getHours())}:{p(d.getMinutes())}
    </span>
  );
}

export function AppShell({ children, appFrame = false }: { children: ReactNode; appFrame?: boolean }) {
  const { session } = useAuthSession();

  // One-shot referral claim: if this account arrived through an affiliate link
  // (?ref= captured in __root), attribute it server-side. The server enforces
  // the attribution window and ignores self-referrals; we just never retry a
  // code twice.
  useEffect(() => {
    if (!session?.access_token) return;
    let code: string | null = null;
    try {
      if (window.localStorage.getItem("iq.ref.claimed")) return;
      code = window.localStorage.getItem("iq.ref");
    } catch {
      return;
    }
    if (!code) return;
    try {
      window.localStorage.setItem("iq.ref.claimed", "1");
    } catch { /* ignore */ }
    void claimReferral({ data: { accessToken: session.access_token, code } }).catch(() => undefined);
  }, [session?.access_token]);

  return (
    <div
      style={{
        background: "var(--iq-bg)",
        color: "var(--iq-ink)",
        fontFamily: "'DM Sans', sans-serif",
        minHeight: "100dvh",
        ...(appFrame ? { display: "flex", flexDirection: "column" } : {}),
      }}
    >
      <SiteNav
        fullBleed
        links={[
          { label: "Support", href: "/community" },
        ]}
      />

      {/* member tab bar — corner-anchored like the nav above: tabs start at
          the viewport's left edge, scan chip + account hold the right */}
      <div style={{ borderBottom: "1px solid var(--iq-line)", background: "var(--iq-glass-nav)" }}>
        <div
          style={{
            padding: "0 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 24,
          }}
        >
          <div className="flex items-center overflow-x-auto" style={{ gap: 24 }}>
            {TABS.map((t) => (
              <Link
                key={t.to}
                to={t.to}
                activeOptions={{ exact: false }}
                style={{
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 12,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  padding: "16px 0",
                  borderBottom: "2px solid transparent",
                  color: "var(--iq-faint)",
                  whiteSpace: "nowrap",
                  textDecoration: "none",
                }}
                activeProps={{
                  style: {
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: 12,
                    letterSpacing: "0.14em",
                    textTransform: "uppercase",
                    padding: "16px 0",
                    color: "var(--iq-ink)",
                    borderBottom: "2px solid #3D69A8",
                    whiteSpace: "nowrap",
                    textDecoration: "none",
                  },
                }}
              >
                {t.label}
              </Link>
            ))}
          </div>
          <div className="hidden md:flex" style={{ paddingTop: 8, paddingBottom: 8, alignItems: "center", gap: 14 }}>
            <ScanChip />
            <AccountLink />
          </div>
        </div>
      </div>

      <main
        style={
          appFrame
            ? { position: "relative", height: "calc(100dvh - 126px)", flexShrink: 0, display: "flex", flexDirection: "column", overflow: "hidden" }
            : { position: "relative" }
        }
      >
        {children}
      </main>

      <SiteFooter />
    </div>
  );
}
