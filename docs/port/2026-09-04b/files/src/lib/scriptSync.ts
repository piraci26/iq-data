import { supabase } from "@/integrations/supabase/client";
import { listScripts, mergeScripts, onScriptChange, type SavedScript } from "@/lib/scriptLibrary";

/* Scripts follow the account. The browser copy stays the working set (every
   view reads it synchronously); this layer pulls the account's rows on
   sign-in and pushes every local change. Merge rule: by id, the newer
   updated_at wins. Nothing here throws into the UI: an absent table, a
   signed-out user or a network failure leaves the local copy in charge. */

type Row = { id: string; user_id: string; name: string; chat_id: string | null; versions: SavedScript["versions"]; updated_at: string };

// the table is newer than the generated types; keep the query loosely typed
const table = () => (supabase as unknown as { from: (t: string) => any }).from("quant_scripts");

let installed = false;
let userId: string | null = null;

async function currentUser(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

/** account rows → local cache. Returns true when the local set changed. */
export async function pullScripts(): Promise<boolean> {
  userId = await currentUser();
  if (!userId) return false;
  try {
    const { data, error } = await table().select("id,user_id,name,chat_id,versions,updated_at").eq("user_id", userId);
    if (error || !Array.isArray(data)) return false;
    const remote: SavedScript[] = (data as Row[]).map((r) => ({ id: r.id, name: r.name, chatId: r.chat_id ?? undefined, versions: Array.isArray(r.versions) ? r.versions : [], ts: Date.parse(r.updated_at) || 0 }));
    return mergeScripts(remote);
  } catch {
    return false;
  }
}

async function pushScript(s: SavedScript) {
  if (!userId) userId = await currentUser();
  if (!userId) return;
  try {
    await table().upsert({ id: s.id, user_id: userId, name: s.name, chat_id: s.chatId ?? null, versions: s.versions, updated_at: new Date(s.ts).toISOString() }, { onConflict: "id" });
  } catch { /* offline or table missing: the local copy stands */ }
}

async function deleteRemote(id: string) {
  if (!userId) userId = await currentUser();
  if (!userId) return;
  try { await table().delete().eq("id", id).eq("user_id", userId); } catch { /* ignore */ }
}

/** call once from the desk: pull now, push every change from then on. Resolves true when the pull changed the local set. */
export async function installScriptSync(): Promise<boolean> {
  if (!installed) {
    installed = true;
    onScriptChange((s, op) => { if (op === "delete") void deleteRemote(s.id); else void pushScript(s); });
  }
  const changed = await pullScripts();
  /* first sign-in on this browser: anything saved before the table existed goes up */
  if (userId) for (const s of listScripts()) void pushScript(s);
  return changed;
}
