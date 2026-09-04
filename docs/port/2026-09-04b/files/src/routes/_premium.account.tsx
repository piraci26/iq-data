import { createFileRoute, Link, useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AppShell } from "@/components/AppShell";
import { TradingViewAccessModal } from "@/components/tradingview/TradingViewAccessModal";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/hooks/useAuthSession";
import { createBillingPortalSession } from "@/lib/payments.functions";
import { getStripeEnvironment } from "@/lib/stripe";

type SectionKey = "profile" | "billing" | "plan";

export const Route = createFileRoute("/_premium/account")({
  validateSearch: (s: Record<string, unknown>): { s?: SectionKey } => {
    const v = typeof s.s === "string" ? s.s : "";
    return v === "billing" || v === "plan" ? { s: v } : {};
  },
  component: AccountRoute,
});

function AccountRoute() {
  return (
    <AppShell>
      <AccountPage />
    </AppShell>
  );
}

/* ---------- shared style helpers ---------- */

const C = {
  heading: "var(--iq-ink)",
  section: "var(--iq-ink)",
  body: "var(--iq-muted)",
  bodyEmph: "var(--iq-ink)",
  helper: "var(--iq-faint)",
  fieldLabel: "var(--iq-faint)",
  accent: "#3D69A8",
  accentSoft: "var(--iq-steel)",
  ctaInk: "var(--iq-bg)",
  hairline: "rgba(255,255,255,0.08)",
  cardBg: "rgba(255,255,255,0.03)",
  subCardBg: "rgba(255,255,255,0.03)",
  inputBg: "rgba(255,255,255,0.03)",
  inputBorder: "rgba(255,255,255,0.09)",
  success: "#2fbf8f",
  successText: "#089981",
  warn: "#e0a94a",
  dangerMuted: "#9b5e5e",
};

type ChipVariant = "green" | "amber" | "neutral";
function Chip({ variant, children }: { variant: ChipVariant; children: ReactNode }) {
  const styles: Record<ChipVariant, CSSProperties> = {
    green: { color: C.successText, background: "rgba(47,191,143,0.12)", border: "1px solid rgba(47,191,143,0.35)" },
    amber: { color: C.warn, background: "rgba(224,169,74,0.13)", border: "1px solid rgba(224,169,74,0.35)" },
    neutral: { color: C.body, background: "transparent", border: "1px solid rgba(255,255,255,0.16)" },
  };
  return (
    <span
      role="status"
      style={{
        ...styles[variant],
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.05em",
        padding: "3px 9px",
        borderRadius: 6,
        textTransform: "uppercase",
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      style={{ fontSize: 11.5, letterSpacing: "0.07em", textTransform: "uppercase", color: C.fieldLabel, fontWeight: 600 }}
    >
      {children}
    </label>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  background: C.inputBg,
  border: `1px solid ${C.inputBorder}`,
  borderRadius: 9,
  padding: "10px 12px",
  color: C.bodyEmph,
  fontSize: 14,
  outline: "none",
  transition: "border-color 150ms, box-shadow 150ms",
  fontFamily: "inherit",
};

const outlineBtn: CSSProperties = {
  background: "transparent",
  color: "var(--iq-ink)",
  border: "1px solid rgba(255,255,255,0.18)",
  borderRadius: 9,
  padding: "9px 16px",
  fontSize: 13.5,
  fontWeight: 500,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  transition: "background 150ms, border-color 150ms",
  fontFamily: "inherit",
};

const primaryBtn: CSSProperties = {
  background: C.accent,
  color: C.ctaInk,
  border: "none",
  borderRadius: 9,
  padding: "10px 18px",
  fontSize: 13.5,
  fontWeight: 600,
  cursor: "pointer",
  boxShadow: "0 6px 24px rgba(61,105,168,0.35)",
  transition: "filter 150ms, box-shadow 150ms",
  fontFamily: "inherit",
};

/* ---------- icons ---------- */

const Icon = {
  tradingView: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 6h18M3 12h12M3 18h7" stroke={C.accentSoft} strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  discord: (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M19.5 5.5A16 16 0 0015.5 4l-.3.6a14 14 0 00-6.4 0L8.5 4a16 16 0 00-4 1.5C2 9 1.5 12.5 1.7 16c1.7 1.3 3.4 2 5 2.5l.7-1.1a8 8 0 01-1.7-.8c.1-.1.3-.2.4-.3 3.3 1.5 6.9 1.5 10.2 0 .1.1.3.2.4.3-.6.3-1.1.6-1.7.8l.7 1.1c1.6-.5 3.3-1.2 5-2.5.2-3.8-.5-7.4-2.7-10.5zM8.7 14.1c-1 0-1.9-1-1.9-2.2s.8-2.2 1.9-2.2 1.9 1 1.9 2.2-.8 2.2-1.9 2.2zm6.6 0c-1 0-1.9-1-1.9-2.2s.8-2.2 1.9-2.2 1.9 1 1.9 2.2-.8 2.2-1.9 2.2z"
        fill="var(--iq-faint)"
      />
    </svg>
  ),
  check: (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  lock: (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" stroke={C.helper} strokeWidth="1.6" />
      <path d="M8 10V7a4 4 0 018 0v3" stroke={C.helper} strokeWidth="1.6" />
    </svg>
  ),
  key: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="8" cy="14" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 12l9-9M17 6l3 3M14 9l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  card: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2 10h20" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  ),
  external: (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  logout: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l-5-5 5-5M5 12h12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  user: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  layers: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l9 5-9 5-9-5 9-5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M3 13l9 5 9-5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ),
};

/* ---------- data types ---------- */

type SubRow = {
  stripe_customer_id: string | null;
  status: string | null;
  current_period_end: string | null;
  current_period_start: string | null;
  cancel_at_period_end: boolean | null;
};

type GrantRow = {
  pine_id: string;
  action: string;
  status: string;
  tv_username: string;
  created_at: string;
};

type TvStatus = "granted" | "pending" | "attention" | "linked" | "not_set";

function deriveTvStatus(username: string | null, grants: GrantRow[]): TvStatus {
  if (!username) return "not_set";
  const mine = grants.filter(
    (g) => g.action === "grant" && g.tv_username.toLowerCase() === username.toLowerCase(),
  );
  if (mine.length === 0) return "linked";
  // Rows arrive newest-first; keep the latest grant per script.
  const latest = new Map<string, GrantRow>();
  for (const g of mine) if (!latest.has(g.pine_id)) latest.set(g.pine_id, g);
  const rows = [...latest.values()];
  if (rows.some((r) => r.status === "failed")) return "attention";
  if (rows.some((r) => r.status === "pending")) return "pending";
  return "granted";
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/* ---------- page ---------- */

const SECTIONS: { key: SectionKey; label: string; icon: ReactNode }[] = [
  { key: "profile", label: "Profile", icon: Icon.user },
  { key: "billing", label: "Billing", icon: Icon.card },
  { key: "plan", label: "Plan & Credits", icon: Icon.layers },
];

function AccountPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const search = useSearch({ from: "/_premium/account" });
  const { session, isPremium, isPlus, isAdmin } = useAuthSession();
  const userId = session?.user.id;
  const email = session?.user.email ?? "";
  const memberSince = fmtDate(session?.user.created_at ?? null);

  const [section, setSection] = useState<SectionKey>(search.s ?? "profile");
  useEffect(() => {
    if (search.s && search.s !== section) setSection(search.s);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.s]);

  const [displayName, setDisplayName] = useState("");
  const [displayNameInitial, setDisplayNameInitial] = useState("");
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [tvSaved, setTvSaved] = useState<string | null>(null);
  const [tvChangedAt, setTvChangedAt] = useState<string | null>(null);
  const [tvStatus, setTvStatus] = useState<TvStatus>("not_set");
  const [tvModalOpen, setTvModalOpen] = useState(false);

  const [subscription, setSubscription] = useState<SubRow | null>(null);
  const [purchasedCredits, setPurchasedCredits] = useState<number | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  const [resetSent, setResetSent] = useState(false);
  const [resetCooldown, setResetCooldown] = useState(0);

  // Load profile + subscription + purchased credit balance
  useEffect(() => {
    if (!userId) return;
    let active = true;
    (async () => {
      const credits = supabase as unknown as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { balance: number } | null }> };
          };
        };
      };
      const [{ data: profile }, { data: subs }, { data: grants }, { data: bal }] = await Promise.all([
        supabase
          .from("profiles")
          .select("display_name,tradingview_username,tradingview_username_updated_at")
          .eq("id", userId)
          .maybeSingle(),
        supabase
          .from("subscriptions")
          .select("stripe_customer_id,status,current_period_end,current_period_start,cancel_at_period_end")
          .eq("user_id", userId)
          .order("updated_at", { ascending: false })
          .limit(1),
        supabase
          .from("tradingview_grants")
          .select("pine_id,action,status,tv_username,created_at")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(50),
        credits.from("ai_purchased_credits").select("balance").eq("user_id", userId).maybeSingle(),
      ]);
      if (!active) return;
      const dn = profile?.display_name ?? "";
      setDisplayName(dn);
      setDisplayNameInitial(dn);
      const tv = profile?.tradingview_username ?? "";
      setTvSaved(tv || null);
      setTvChangedAt(profile?.tradingview_username_updated_at ?? null);
      setTvStatus(deriveTvStatus(tv || null, grants ?? []));
      setSubscription((subs?.[0] as SubRow | undefined) ?? null);
      setPurchasedCredits(bal?.balance ?? 0);
    })();
    return () => {
      active = false;
    };
  }, [userId]);

  // Reset cooldown ticker
  useEffect(() => {
    if (resetCooldown <= 0) return;
    const id = window.setTimeout(() => setResetCooldown((s) => s - 1), 1000);
    return () => window.clearTimeout(id);
  }, [resetCooldown]);

  // Saved badge auto-clear
  useEffect(() => {
    if (!savedAt) return;
    const id = window.setTimeout(() => setSavedAt(null), 2000);
    return () => window.clearTimeout(id);
  }, [savedAt]);

  /* ---------- derived plan facts ---------- */

  const planName = isPlus ? "IQ Plus" : "IQ Pro";
  const subActive = subscription?.status === "active" || subscription?.status === "trialing";
  const isDemo = isPremium && !subscription;

  const cycle = useMemo(() => {
    if (!subscription?.current_period_start || !subscription.current_period_end) return null;
    const days =
      (new Date(subscription.current_period_end).getTime() -
        new Date(subscription.current_period_start).getTime()) /
      86400000;
    return days > 40 ? "Yearly" : "Monthly";
  }, [subscription]);

  const renewDate = fmtDate(subscription?.current_period_end);
  const daysLeft = useMemo(() => {
    if (!subscription?.current_period_end) return null;
    const ms = new Date(subscription.current_period_end).getTime() - Date.now();
    return ms > 0 ? Math.ceil(ms / 86400000) : null;
  }, [subscription]);
  const endsInsteadOfRenews = subscription?.cancel_at_period_end === true;

  const lastPayment = fmtDate(subscription?.current_period_start);
  const dailyCap = isPlus || isAdmin ? 250 : 100;

  /* ---------- handlers ---------- */

  const saveDisplayName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!userId) return;
    const trimmed = displayName.trim();
    if (!trimmed) {
      setDisplayNameError("Enter a display name.");
      return;
    }
    setDisplayNameError(null);
    setSavingName(true);
    await supabase.from("profiles").update({ display_name: trimmed }).eq("id", userId);
    setSavingName(false);
    setDisplayNameInitial(trimmed);
    setSavedAt(Date.now());
  };

  // Admins skip the 30-day cooldown; everyone else waits it out.
  const tvCooldownUntil = useMemo(() => {
    if (isAdmin || !tvSaved || !tvChangedAt) return null;
    const until = new Date(new Date(tvChangedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
    return until.getTime() > Date.now() ? until : null;
  }, [tvSaved, tvChangedAt, isAdmin]);

  const onTvLinked = (username: string, allGranted?: boolean) => {
    setTvSaved(username);
    setTvChangedAt(new Date().toISOString());
    setTvStatus(allGranted ? "granted" : "pending");
  };

  const openBillingPortal = async () => {
    setPortalError(null);
    if (!subscription?.stripe_customer_id) {
      navigate({ to: "/pricing" });
      return;
    }
    setPortalLoading(true);
    try {
      const result = await createBillingPortalSession({
        data: {
          customerId: subscription.stripe_customer_id,
          returnUrl: `${window.location.origin}/account`,
          environment: getStripeEnvironment(),
        },
      });
      if ("error" in result) throw new Error(result.error);
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setPortalError(err instanceof Error ? err.message : "Could not open billing portal.");
    } finally {
      setPortalLoading(false);
    }
  };

  const sendPasswordReset = async () => {
    if (!email || resetCooldown > 0) return;
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setResetSent(true);
    setResetCooldown(60);
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    await router.invalidate();
    navigate({ to: "/", replace: true });
  };

  const goSection = (key: SectionKey) => {
    setSection(key);
    navigate({ to: "/account", search: key === "profile" ? {} : { s: key }, replace: true });
  };

  const avatarInitials = (displayName || email || "?")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();

  const sectionLabel = SECTIONS.find((s) => s.key === section)?.label ?? "Profile";

  /* ---------- render ---------- */

  return (
    <div style={{ fontFamily: "'DM Sans', ui-sans-serif, system-ui, sans-serif", color: C.body }}>
      <style>{`
        .acc-input:focus { border-color: ${C.accent} !important; box-shadow: 0 0 0 3px rgba(61,105,168,0.18); }
        .acc-outline-btn:hover { background: rgba(255,255,255,0.04); border-color: rgba(255,255,255,0.3); }
        .acc-outline-btn:focus-visible, .acc-primary-btn:focus-visible, .acc-link:focus-visible, .acc-nav-btn:focus-visible { outline: 2px solid ${C.accentSoft}; outline-offset: 2px; border-radius: 6px; }
        .acc-primary-btn:hover { filter: brightness(1.08); }
        .acc-link { color: ${C.accentSoft}; text-decoration: none; }
        .acc-link:hover { text-decoration: underline; }
        .acc-nav-btn { transition: background 140ms, color 140ms; }
        .acc-nav-btn:hover { background: rgba(255,255,255,0.05); }
        @media (max-width: 1024px) { .acc-px { padding-left: 32px !important; padding-right: 32px !important; } }
        @media (max-width: 900px) {
          .acc-layout { grid-template-columns: 1fr !important; }
          .acc-sidenav { flex-direction: row !important; overflow-x: auto; position: static !important; }
          .acc-access-grid { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 768px) {
          .acc-px { padding-left: 20px !important; padding-right: 20px !important; }
          .acc-plan-card { flex-direction: column !important; align-items: flex-start !important; gap: 16px !important; }
        }
      `}</style>

      <div className="acc-px" style={{ maxWidth: 1240, margin: "0 auto", padding: "36px 64px 40px" }}>
        {/* Breadcrumb */}
        <div style={{ fontSize: 13, color: C.helper, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ color: C.body }}>Account</span>
          <span aria-hidden style={{ opacity: 0.6 }}>›</span>
          <span style={{ color: C.heading }}>{sectionLabel}</span>
        </div>

        <div
          className="acc-layout"
          style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 40, marginTop: 26, alignItems: "start" }}
        >
          {/* ---------- side nav ---------- */}
          <nav
            className="acc-sidenav"
            aria-label="Account sections"
            style={{ display: "flex", flexDirection: "column", gap: 4, position: "sticky", top: 90 }}
          >
            <div style={{ fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase", color: C.helper, padding: "0 12px 8px" }}>
              Account
            </div>
            {SECTIONS.map((s) => {
              const active = s.key === section;
              return (
                <button
                  key={s.key}
                  type="button"
                  className="acc-nav-btn"
                  onClick={() => goSection(s.key)}
                  aria-current={active ? "page" : undefined}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "10px 12px",
                    borderRadius: 9,
                    border: "none",
                    cursor: "pointer",
                    textAlign: "left",
                    fontFamily: "inherit",
                    fontSize: 14,
                    fontWeight: active ? 600 : 500,
                    color: active ? C.heading : C.body,
                    background: active ? "rgba(255,255,255,0.06)" : "transparent",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ display: "inline-flex", color: active ? C.accentSoft : C.helper }}>{s.icon}</span>
                  {s.label}
                </button>
              );
            })}
          </nav>

          {/* ---------- section content ---------- */}
          <div style={{ minWidth: 0 }}>
            {section === "profile" && (
              <SectionShell title="Profile" lead="Your account and connections.">
                {/* identity card */}
                <Card>
                  <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                    <div
                      aria-hidden
                      style={{
                        width: 52, height: 52, borderRadius: "50%",
                        background: "rgba(61,105,168,0.18)", color: C.accentSoft,
                        display: "inline-flex", alignItems: "center", justifyContent: "center",
                        fontSize: 17, fontWeight: 600, letterSpacing: "0.04em", flexShrink: 0,
                      }}
                    >
                      {avatarInitials}
                    </div>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 16.5, fontWeight: 600, color: C.heading }}>
                        {displayNameInitial || email}
                      </div>
                      <div style={{ fontSize: 13, color: C.helper, marginTop: 3 }}>
                        {email}
                        {memberSince && <> · Member since {memberSince}</>}
                      </div>
                    </div>
                    {isAdmin ? (
                      /* the admin console used to hang off the account dropdown; the badge is its home now */
                      <Link to="/admin" title="Open the admin console" style={{ textDecoration: "none" }}>
                        <Chip variant="green">Admin →</Chip>
                      </Link>
                    ) : (
                      <Chip variant={isPremium ? "green" : "neutral"}>{isPremium ? planName : "Free"}</Chip>
                    )}
                  </div>

                  <div style={{ height: 1, background: C.hairline, margin: "20px 0" }} />

                  <form onSubmit={saveDisplayName}>
                    <FieldLabel htmlFor="acc-name">Display name</FieldLabel>
                    <div style={{ display: "flex", gap: 10, marginTop: 6, alignItems: "flex-start", flexWrap: "wrap" }}>
                      <input
                        id="acc-name"
                        type="text"
                        value={displayName}
                        onChange={(e) => {
                          setDisplayName(e.target.value);
                          if (displayNameError) setDisplayNameError(null);
                        }}
                        className="acc-input"
                        style={{ ...inputStyle, maxWidth: 300, borderColor: displayNameError ? "#F23645" : C.inputBorder }}
                        aria-invalid={!!displayNameError}
                        aria-describedby={displayNameError ? "name-error" : undefined}
                      />
                      <button
                        type="submit"
                        className="acc-primary-btn"
                        style={{ ...primaryBtn, opacity: savingName ? 0.7 : 1 }}
                        disabled={savingName || displayName === displayNameInitial}
                      >
                        {savedAt ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            Saved {Icon.check}
                          </span>
                        ) : savingName ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {displayNameError && (
                      <p id="name-error" style={{ fontSize: 12.5, color: "#F23645", marginTop: 6 }}>
                        {displayNameError}
                      </p>
                    )}
                    <p style={{ fontSize: 12.5, color: C.helper, marginTop: 10, display: "flex", alignItems: "center", gap: 6 }}>
                      {Icon.lock} Email is used for sign in and receipts — contact support to change it.
                    </p>
                  </form>
                </Card>

                {/* connections */}
                <div style={{ marginTop: 26 }}>
                  <h3 style={{ fontSize: 15.5, fontWeight: 600, color: C.section, margin: "0 0 4px" }}>Connections</h3>
                  <p style={{ fontSize: 13, color: C.helper, margin: "0 0 14px" }}>
                    Indicators go to your TradingView account. Alerts and community will run through Discord.
                  </p>

                  <div className="acc-access-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                    {/* TradingView */}
                    <div style={{ background: C.subCardBg, border: `1px solid ${C.hairline}`, borderRadius: 11, padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                          {Icon.tradingView}
                          <span style={{ fontSize: 14, fontWeight: 500, color: C.section }}>TradingView</span>
                        </div>
                        {tvStatus === "granted" && <Chip variant="green">{Icon.check} Granted</Chip>}
                        {tvStatus === "pending" && <Chip variant="amber">Pending</Chip>}
                        {tvStatus === "attention" && <Chip variant="amber">Needs attention</Chip>}
                        {tvStatus === "linked" && <Chip variant="neutral">Linked</Chip>}
                        {tvStatus === "not_set" && <Chip variant="neutral">Not set</Chip>}
                      </div>

                      <FieldLabel>Username</FieldLabel>
                      <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center" }}>
                        <div style={{ ...inputStyle, display: "flex", alignItems: "center", minHeight: 38, color: tvSaved ? C.bodyEmph : C.helper, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>
                          {tvSaved ?? "Not linked yet"}
                        </div>
                        <button
                          type="button"
                          className="acc-outline-btn"
                          onClick={() => setTvModalOpen(true)}
                          disabled={!!tvCooldownUntil}
                          style={{ ...outlineBtn, opacity: tvCooldownUntil ? 0.55 : 1 }}
                        >
                          {tvSaved ? "Change" : "Link"}
                        </button>
                      </div>
                      <p style={{ fontSize: 12.5, color: "var(--iq-faint)", marginTop: 10, lineHeight: 1.5 }}>
                        IQ Bands and the IQ Oscillator are invite-only scripts. Changing this moves your
                        access to the new account, and can be done once every 30 days.
                        {tvStatus === "pending" && <> Invites can take a few minutes to apply.</>}
                        {tvStatus === "attention" && (
                          <> A grant didn&apos;t go through — we&apos;re retrying automatically, and support steps in if it stays stuck.</>
                        )}
                        {tvCooldownUntil && (
                          <>
                            {" "}You can change it again on{" "}
                            {tvCooldownUntil.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
                          </>
                        )}
                      </p>
                    </div>

                    {/* Discord — not available yet */}
                    <div style={{ background: C.subCardBg, border: `1px solid ${C.hairline}`, borderRadius: 11, padding: 20 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                          {Icon.discord}
                          <span style={{ fontSize: 14, fontWeight: 500, color: C.section }}>Discord</span>
                        </div>
                        <Chip variant="neutral">Coming soon</Chip>
                      </div>
                      <p style={{ fontSize: 13, color: C.body, margin: 0, lineHeight: 1.6 }}>
                        Discord isn&apos;t available right now — it&apos;s coming soon. The members
                        channels and alert feeds will connect from here the moment it ships, with
                        your role synced to your plan automatically.
                      </p>
                    </div>
                  </div>
                </div>

                {/* security */}
                <div style={{ marginTop: 26 }}>
                  <h3 style={{ fontSize: 15.5, fontWeight: 600, color: C.section, margin: "0 0 14px" }}>Security</h3>
                  <Card>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontSize: 14.5, fontWeight: 500, color: C.section }}>Password</div>
                        <div style={{ fontSize: 13, color: "var(--iq-faint)", marginTop: 4 }}>
                          {resetSent
                            ? `Link sent to ${email}. It expires in 30 minutes.`
                            : "We'll email you a secure link to set a new one."}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="acc-outline-btn"
                        style={{ ...outlineBtn, opacity: resetCooldown > 0 ? 0.6 : 1 }}
                        onClick={sendPasswordReset}
                        disabled={resetCooldown > 0}
                      >
                        {Icon.key}
                        <span>{resetCooldown > 0 ? `Resend in ${resetCooldown}s` : "Change password"}</span>
                      </button>
                    </div>
                  </Card>
                </div>
              </SectionShell>
            )}

            {section === "billing" && (
              <SectionShell title="Billing" lead="Invoices, receipts and payment methods live in Stripe.">
                <Card>
                  <div className="acc-plan-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 20 }}>
                    <div>
                      <div style={{ fontSize: 14.5, fontWeight: 500, color: C.section }}>Stripe billing portal</div>
                      <div style={{ fontSize: 13, color: C.body, marginTop: 6, lineHeight: 1.55, maxWidth: 460 }}>
                        Your full billing history, downloadable invoices, card details and
                        cancellation all live in the secure Stripe portal — nothing billing-related
                        is stored on Alpha Charts.
                      </div>
                      {portalError && <div style={{ fontSize: 12, color: "#F23645", marginTop: 8 }}>{portalError}</div>}
                    </div>
                    <button
                      type="button"
                      className="acc-outline-btn"
                      style={outlineBtn}
                      onClick={openBillingPortal}
                      disabled={portalLoading}
                    >
                      {Icon.card}
                      <span>{portalLoading ? "Opening…" : "Manage billing"}</span>
                      {Icon.external}
                    </button>
                  </div>
                </Card>

                <Card style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 14.5, fontWeight: 500, color: C.section }}>Latest payment</div>
                  <div style={{ fontSize: 13, color: C.body, marginTop: 6 }}>
                    {lastPayment ? (
                      <>
                        {planName} · billed {lastPayment}. The invoice and receipt are in the{" "}
                        <button
                          type="button"
                          onClick={openBillingPortal}
                          className="acc-link"
                          style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 13, fontFamily: "inherit" }}
                        >
                          billing portal
                        </button>
                        .
                      </>
                    ) : isDemo ? (
                      "Access granted manually — no payments on file."
                    ) : (
                      "No payments yet."
                    )}
                  </div>
                </Card>
              </SectionShell>
            )}

            {section === "plan" && (
              <SectionShell title="Plan & Credits" lead="What you're on, when it renews, and your AI balance.">
                {/* plan card */}
                <Card>
                  <div className="acc-plan-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20 }}>
                    <div>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <span style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 600, fontSize: 20, color: C.heading }}>
                          {isPremium ? planName : "Free"}
                        </span>
                        {subActive && <Chip variant="green">{Icon.check} Active</Chip>}
                        {isDemo && <Chip variant="amber">Granted manually</Chip>}
                        {subscription && !subActive && <Chip variant="amber">{subscription.status ?? "Inactive"}</Chip>}
                      </div>
                      <div style={{ fontSize: 13.5, color: C.body, marginTop: 8, lineHeight: 1.6 }}>
                        {subscription && renewDate ? (
                          endsInsteadOfRenews ? (
                            <>
                              Renewal is off — your access{" "}
                              <span style={{ color: C.warn, fontWeight: 600 }}>ends on {renewDate}</span>
                              {daysLeft !== null && <> ({daysLeft} {daysLeft === 1 ? "day" : "days"} left)</>}.
                              Turn renewal back on any time in the billing portal.
                            </>
                          ) : (
                            <>
                              {cycle ?? "Subscription"} billing ·{" "}
                              <span style={{ color: C.bodyEmph, fontWeight: 600 }}>renews on {renewDate}</span>
                              {daysLeft !== null && <> ({daysLeft} {daysLeft === 1 ? "day" : "days"} left in this cycle)</>}.
                            </>
                          )
                        ) : isDemo ? (
                          "Full access, granted outside Stripe — no renewal date applies."
                        ) : (
                          "No active subscription."
                        )}
                      </div>
                      {portalError && <div style={{ fontSize: 12, color: "#F23645", marginTop: 8 }}>{portalError}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
                      <button
                        type="button"
                        className="acc-outline-btn"
                        style={outlineBtn}
                        onClick={openBillingPortal}
                        disabled={portalLoading}
                      >
                        {Icon.card}
                        <span>{portalLoading ? "Opening…" : "Manage billing"}</span>
                        {Icon.external}
                      </button>
                      <Link to="/pricing" className="acc-link" style={{ fontSize: 13 }}>
                        View plans
                      </Link>
                    </div>
                  </div>
                </Card>

                {/* credits card */}
                <Card style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 20, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ fontSize: 14.5, fontWeight: 500, color: C.section }}>AI credits</div>
                      <div style={{ display: "flex", gap: 36, marginTop: 14, flexWrap: "wrap" }}>
                        <div>
                          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: C.heading }}>
                            {dailyCap}
                          </div>
                          <div style={{ fontSize: 12, color: C.helper, marginTop: 3 }}>
                            Daily allowance · resets at midnight UTC
                          </div>
                        </div>
                        <div>
                          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 22, fontWeight: 600, color: purchasedCredits ? C.successText : C.heading }}>
                            {purchasedCredits ?? "—"}
                          </div>
                          <div style={{ fontSize: 12, color: C.helper, marginTop: 3 }}>
                            Purchased · never expires, spends after the daily pool
                          </div>
                        </div>
                      </div>
                    </div>
                    <Link
                      to="/topup"
                      className="acc-primary-btn"
                      style={{ ...primaryBtn, textDecoration: "none", display: "inline-flex", alignItems: "center" }}
                    >
                      Top up credits
                    </Link>
                  </div>
                </Card>
              </SectionShell>
            )}

            {/* footer actions */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", paddingTop: 30, gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  if (confirm("Cancel your plan? You'll be taken to the Stripe portal to complete cancellation.")) {
                    void openBillingPortal();
                  }
                }}
                style={{ background: "transparent", border: "none", color: C.dangerMuted, fontSize: 13, cursor: "pointer", padding: 0, fontFamily: "inherit" }}
              >
                Cancel plan
              </button>
              <button type="button" className="acc-outline-btn" style={{ ...outlineBtn, color: "var(--iq-muted)" }} onClick={signOut}>
                {Icon.logout}
                <span>Sign out</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      <TradingViewAccessModal
        open={tvModalOpen}
        onOpenChange={setTvModalOpen}
        onLinked={onTvLinked}
      />
    </div>
  );
}

/* ---------- section + card shells ---------- */

function SectionShell({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section aria-label={title}>
      <h1 style={{ fontFamily: "'DM Sans', sans-serif", fontWeight: 600, fontSize: 30, color: C.heading, margin: 0, letterSpacing: "-0.01em" }}>
        {title}
      </h1>
      <p style={{ fontSize: 14, color: C.helper, margin: "6px 0 24px" }}>{lead}</p>
      {children}
    </section>
  );
}

function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: C.cardBg,
        border: `1px solid ${C.hairline}`,
        borderRadius: 14,
        padding: 22,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
