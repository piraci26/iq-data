import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { TradingViewAccessModal } from "@/components/tradingview/TradingViewAccessModal";
import { supabase } from "@/integrations/supabase/client";
import { useAuthSession } from "@/hooks/useAuthSession";

export const Route = createFileRoute("/_premium/_subscribed")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data: sessionData } = await supabase.auth.getSession();
    const user = sessionData.session?.user;
    if (!user) {
      throw redirect({ to: "/login", search: { redirect: location.href } });
    }

    const { data: roles } = await supabase
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);

    const list = (roles ?? []).map((r) => r.role);
    const hasAccess = list.includes("premium") || list.includes("admin");
    if (!hasAccess) throw redirect({ to: "/pricing" });
  },
  component: SubscribedLayout,
});

function SubscribedLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // App-frame pages: shared nav + tab bar on top, then the page fills the
  // remaining viewport with no footer and no page scroll.
  const appFrame =
    pathname.startsWith("/analyst") || pathname.startsWith("/quant") || pathname.startsWith("/screener") || pathname.startsWith("/signals");
  const { session, isPremium } = useAuthSession();
  const userId = session?.user.id;
  const [tvUsername, setTvUsername] = useState<string | null>(null);
  const [tvLoaded, setTvLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const autoOpened = useRef(false);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("tradingview_username")
        .eq("id", userId)
        .maybeSingle();
      if (!active) return;
      setTvUsername(data?.tradingview_username ?? null);
      setTvLoaded(true);
    })();
    return () => {
      active = false;
    };
  }, [userId]);

  const needsLink = tvLoaded && isPremium && !tvUsername;

  useEffect(() => {
    if (needsLink && !autoOpened.current) {
      autoOpened.current = true;
      setModalOpen(true);
    }
  }, [needsLink]);

  return (
    <AppShell appFrame={appFrame}>
      {needsLink && (
        <div className="border-b border-border bg-muted/20">
          <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-6 py-2.5">
            <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
              Link your TradingView username to activate indicator access
            </p>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="shrink-0 rounded-sm border border-border px-3 py-1 font-mono text-[11px] uppercase tracking-wider text-foreground hover:bg-muted"
            >
              Link now
            </button>
          </div>
        </div>
      )}
      <TradingViewAccessModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        onLinked={(username) => setTvUsername(username)}
      />
      <Outlet />
    </AppShell>
  );
}
