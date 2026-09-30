"use client";
import { createClient } from "@/lib/supabase/client";
import { getDeviceId } from "@/lib/device";
import { idb, STORES } from "./idb";

export type Breakdown = { unit_id: string; qty: string }[];

export type QueuedEntry = {
  client_entry_id: string;
  session_id: string;
  product_id: string;
  storage_location_id: string | null;
  breakdown: Breakdown;
  clear?: boolean;
  base_revision: number | null;
  method: string;
  voice_transcript?: string | null;
  voice_confidence?: number | null;
  counted_at: string;
  device_id: string;
  queued_at: number;
  error?: string;
};

/** Latest known value of a count line on this device (server-confirmed or pending). */
export type LocalEntry = {
  key: string;
  session_id: string;
  product_id: string;
  storage_location_id: string | null;
  breakdown: Breakdown;
  quantity: number | null;
  revision: number | null;
  pending: boolean;
  cleared?: boolean;
  has_conflict?: boolean;
  recount_requested?: boolean;
  counted_by_name?: string | null;
  counted_at?: string | null;
  method?: string;
  voice_transcript?: string | null;
  error?: string;
};

export type SyncState = "synced" | "syncing" | "offline" | "error";
export type SyncStatus = { state: SyncState; pending: number; lastError?: string; lastSyncedAt?: number };

export const lineKey = (session: string, product: string, storage: string | null) => `${session}|${product}|${storage ?? "none"}`;

let status: SyncStatus = { state: "synced", pending: 0 };
const listeners = new Set<(s: SyncStatus) => void>();
let flushing: Promise<void> | null = null;
let started = false;

function emit(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  for (const l of listeners) l(status);
}

export function subscribeSync(fn: (s: SyncStatus) => void) {
  listeners.add(fn);
  fn(status);
  startSyncLoop();
  return () => listeners.delete(fn);
}

async function refreshPending() {
  const n = await idb.count(STORES.queue);
  emit({ pending: n, state: n === 0 && status.state !== "error" ? (navigator.onLine ? "synced" : "offline") : status.state });
  return n;
}

export function startSyncLoop() {
  if (started || typeof window === "undefined") return;
  started = true;
  navigator.storage?.persist?.().catch(() => undefined);
  window.addEventListener("online", () => void flush());
  window.addEventListener("offline", () => emit({ state: "offline" }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void flush(); });
  navigator.serviceWorker?.addEventListener("message", (e) => { if (e.data?.type === "flush-counts") void flush(); });
  setInterval(() => void flush(), 15000);
  void refreshPending().then(() => flush());
}

/** Save a count entry on the device first, then try to sync. Never throws for network problems. */
export async function enqueueEntry(e: Omit<QueuedEntry, "client_entry_id" | "device_id" | "queued_at" | "counted_at">, local: Partial<LocalEntry>) {
  const item: QueuedEntry = {
    ...e,
    client_entry_id: crypto.randomUUID(),
    device_id: getDeviceId(),
    queued_at: Date.now(),
    counted_at: new Date().toISOString(),
  };
  await idb.put(STORES.queue, item);
  const key = lineKey(e.session_id, e.product_id, e.storage_location_id);
  const prev = await idb.get<LocalEntry>(STORES.entries, key);
  const base: Partial<LocalEntry> = { revision: null, quantity: null, counted_by_name: null };
  await idb.put<LocalEntry>(STORES.entries, {
    ...base,
    ...prev,
    ...local,
    key, session_id: e.session_id, product_id: e.product_id, storage_location_id: e.storage_location_id,
    breakdown: e.breakdown, pending: true, cleared: !!e.clear, method: e.method, voice_transcript: e.voice_transcript ?? null, error: undefined,
  });
  // Ask the service worker to retry in the background if the page closes before sync.
  navigator.serviceWorker?.ready
    .then((reg) => (reg as ServiceWorkerRegistration & { sync?: { register: (t: string) => Promise<void> } }).sync?.register("count-sync"))
    .catch(() => undefined);
  await refreshPending();
  void flush();
  return item;
}

export function flush(): Promise<void> {
  if (flushing) return flushing;
  flushing = doFlush().finally(() => { flushing = null; });
  return flushing;
}

type ServerResult = { client_entry_id: string; status: "applied" | "conflict" | "duplicate" | "cleared"; entry: Record<string, unknown> | null };

async function doFlush() {
  const queue = (await idb.all<QueuedEntry>(STORES.queue)).sort((a, b) => a.queued_at - b.queued_at);
  if (queue.length === 0) { emit({ state: "synced", pending: 0 }); return; }
  if (!navigator.onLine) { emit({ state: "offline", pending: queue.length }); return; }
  emit({ state: "syncing", pending: queue.length });
  const supabase = createClient();
  const bySession = new Map<string, QueuedEntry[]>();
  for (const q of queue) {
    if (q.error) continue; // needs user attention
    if (!bySession.has(q.session_id)) bySession.set(q.session_id, []);
    bySession.get(q.session_id)!.push(q);
  }
  let hadError: string | undefined;
  for (const [session, items] of bySession) {
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50);
      let res: { data: unknown; error: { message: string; code?: string } | null };
      try {
        res = await supabase.rpc("save_count_entries", {
          p_session: session,
          p_entries: batch.map((b) => ({
            client_entry_id: b.client_entry_id, product_id: b.product_id, storage_location_id: b.storage_location_id,
            breakdown: b.breakdown, base_revision: b.base_revision, method: b.method, voice_transcript: b.voice_transcript,
            voice_confidence: b.voice_confidence, counted_at: b.counted_at, device_id: b.device_id, clear: b.clear ?? false,
          })),
        });
      } catch (err) {
        emit({ state: "offline" });
        return; // network failure: keep everything queued
      }
      if (res.error) {
        const msg = res.error.message;
        if (/fetch|network|Failed to fetch|Load failed/i.test(msg) || !res.error.code) { emit({ state: "offline" }); return; }
        if (res.error.code === "PGRST301" || /JWT/i.test(msg)) { hadError = "Sign in again to sync your counts"; break; }
        // Business error (e.g. count already posted): park the entries with the reason; never delete them silently.
        for (const b of batch) {
          await idb.put(STORES.queue, { ...b, error: msg });
          const key = lineKey(b.session_id, b.product_id, b.storage_location_id);
          const le = await idb.get<LocalEntry>(STORES.entries, key);
          if (le) await idb.put(STORES.entries, { ...le, error: msg });
        }
        hadError = msg;
        continue;
      }
      const results = ((res.data as { results: ServerResult[] }).results ?? []);
      for (const r of results) {
        const b = batch.find((x) => x.client_entry_id === r.client_entry_id);
        if (!b) continue;
        await idb.del(STORES.queue, b.client_entry_id);
        const key = lineKey(b.session_id, b.product_id, b.storage_location_id);
        const stillQueued = (await idb.byIndex<QueuedEntry>(STORES.queue, "session_id", b.session_id))
          .some((q) => lineKey(q.session_id, q.product_id, q.storage_location_id) === key);
        const le = await idb.get<LocalEntry>(STORES.entries, key);
        const e = r.entry;
        if (r.status === "cleared" && !e) {
          if (le && !stillQueued) await idb.put(STORES.entries, { ...le, pending: false, cleared: true, quantity: null, revision: null, breakdown: [] });
          continue;
        }
        if (!e) continue;
        const next: LocalEntry = {
          ...(le ?? { key, session_id: b.session_id, product_id: b.product_id, storage_location_id: b.storage_location_id, breakdown: [], quantity: null, revision: null, pending: false }),
          revision: Number(e.revision),
          has_conflict: !!e.has_conflict,
          recount_requested: !!e.recount_requested,
          counted_by_name: (e.counted_by_name as string) ?? le?.counted_by_name ?? null,
          pending: stillQueued,
          error: undefined,
        };
        if (!stillQueued) {
          next.quantity = Number(e.quantity);
          next.breakdown = ((e.breakdown as { unit_id: string; qty: number }[]) ?? []).map((x) => ({ unit_id: x.unit_id, qty: String(x.qty) }));
          next.cleared = false;
        }
        await idb.put(STORES.entries, next);
      }
    }
  }
  const pending = await idb.count(STORES.queue);
  emit({ state: hadError ? "error" : pending ? "syncing" : "synced", pending, lastError: hadError, lastSyncedAt: Date.now() });
  window.dispatchEvent(new CustomEvent("count-synced"));
}

/** Entries on this device that could not be saved (e.g. the count was posted meanwhile). */
export async function discardFailed(clientEntryId: string) {
  await idb.del(STORES.queue, clientEntryId);
  await refreshPending();
}
