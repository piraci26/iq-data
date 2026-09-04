import type { WbRender } from "@/lib/pineRender";

/* Your scripts, kept: every save is a version with a note. Local for now
   (per browser), shaped so it moves to a table later without changing the
   Quant desk. A script remembers the chat that built it (chatId) so the
   backtest can send fixes back to the creator conversation, and the chat
   can file new versions as the copilot or the optimiser produces them. */

export type ScriptVersion = { v: number; code: string; render: WbRender | null; note: string; ts: number };
export type SavedScript = { id: string; name: string; versions: ScriptVersion[]; ts: number; chatId?: string };

const KEY = "iq.lab.scripts.v1";

const canStore = () => typeof window !== "undefined" && !!window.localStorage;

/* one listener (the account sync) hears every change */
type ChangeOp = "save" | "delete";
let listener: ((s: SavedScript, op: ChangeOp) => void) | null = null;
export function onScriptChange(fn: (s: SavedScript, op: ChangeOp) => void) { listener = fn; }
const notify = (s: SavedScript, op: ChangeOp) => { try { listener?.(s, op); } catch { /* never let sync break a save */ } };

/* account rows into the local set: by id, newer ts wins; returns true if anything changed */
export function mergeScripts(remote: SavedScript[]): boolean {
  const local = listScripts();
  const byId = new Map(local.map((s) => [s.id, s]));
  let changed = false;
  for (const r of remote) {
    const l = byId.get(r.id);
    if (!l) { byId.set(r.id, r); changed = true; }
    else if ((r.ts ?? 0) > (l.ts ?? 0) || r.versions.length > l.versions.length) { byId.set(r.id, { ...l, ...r }); changed = true; }
  }
  if (changed) persist([...byId.values()]);
  return changed;
}

export function listScripts(): SavedScript[] {
  if (!canStore()) return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as SavedScript[]) : [];
    return Array.isArray(arr) ? arr.sort((a, b) => b.ts - a.ts) : [];
  } catch {
    return [];
  }
}

function persist(list: SavedScript[]) {
  if (!canStore()) return;
  try { window.localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* quota or private mode */ }
}

export function nameFromCode(code: string): string {
  const m = code.match(/\b(?:indicator|strategy)\s*\(\s*"([^"]+)"/);
  return m ? m[1].trim() : "Untitled script";
}

export function getScript(id: string): SavedScript | null {
  return listScripts().find((s) => s.id === id) ?? null;
}

export function findByChat(chatId: string): SavedScript | null {
  return listScripts().find((s) => s.chatId === chatId) ?? null;
}

export const latestVersion = (s: SavedScript): ScriptVersion => s.versions[s.versions.length - 1];

/* same name → a new version; new name → a new script. Identical code never
   makes a duplicate version. */
export function saveScript(input: { code: string; render: WbRender | null; name?: string; note?: string; chatId?: string }): SavedScript {
  const name = (input.name ?? nameFromCode(input.code)).slice(0, 80);
  const list = listScripts();
  const now = Date.now();
  /* the chat's own script first; a same-named script from ANOTHER chat is a
     different script (the copilot reuses titles), so it gets a numbered name */
  let existing = input.chatId ? list.find((s) => s.chatId === input.chatId) : undefined;
  if (!existing) {
    const sameName = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (sameName && (!sameName.chatId || !input.chatId || sameName.chatId === input.chatId)) existing = sameName;
  }
  const finalName = existing ? existing.name : (() => { let candidate = name, k = 2; while (list.some((s) => s.name.toLowerCase() === candidate.toLowerCase())) candidate = `${name} (${k++})`; return candidate; })();
  if (existing) {
    if (input.chatId && !existing.chatId) existing.chatId = input.chatId;
    const last = latestVersion(existing);
    if (last && last.code === input.code) { existing.ts = now; persist(list); return existing; }
    existing.versions.push({ v: existing.versions.length + 1, code: input.code, render: input.render, note: input.note ?? "saved from the copilot", ts: now });
    existing.ts = now;
    persist(list);
    notify(existing, "save");
    return existing;
  }
  const s: SavedScript = { id: `s${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: finalName, ts: now, chatId: input.chatId, versions: [{ v: 1, code: input.code, render: input.render, note: input.note ?? "first save", ts: now }] };
  persist([s, ...list]);
  notify(s, "save");
  return s;
}

/* a new version on an existing script (the optimiser, an auto-filed copilot
   fix). Returns the script, or null when the id is unknown. Identical code
   returns the script unchanged. */
export function addVersion(id: string, input: { code: string; render: WbRender | null; note: string }): SavedScript | null {
  const list = listScripts();
  const s = list.find((x) => x.id === id);
  if (!s) return null;
  const last = latestVersion(s);
  if (last && last.code === input.code) return s;
  s.versions.push({ v: s.versions.length + 1, code: input.code, render: input.render, note: input.note, ts: Date.now() });
  s.ts = Date.now();
  persist(list);
  notify(s, "save");
  return s;
}

export function linkScriptToChat(id: string, chatId: string) {
  const list = listScripts();
  const s = list.find((x) => x.id === id);
  if (!s || s.chatId === chatId) return;
  s.chatId = chatId;
  persist(list);
  notify(s, "save");
}

export function deleteScript(id: string) {
  const gone = listScripts().find((s) => s.id === id);
  persist(listScripts().filter((s) => s.id !== id));
  if (gone) notify(gone, "delete");
}

/* a unified-style diff of two versions: kept, added, removed lines */
export function diffLines(a: string, b: string): { k: " " | "+" | "-"; s: string }[] {
  const A = a.split("\n"), B = b.split("\n");
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { k: " " | "+" | "-"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ k: " ", s: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ k: "-", s: A[i] }); i++; }
    else { out.push({ k: "+", s: B[j] }); j++; }
  }
  while (i < n) out.push({ k: "-", s: A[i++] });
  while (j < m) out.push({ k: "+", s: B[j++] });
  return out;
}
