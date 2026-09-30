"use client";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { idb, STORES } from "@/lib/offline/idb";
import { Button } from "@/components/ui";
import { useToast } from "@/components/client";

/** Pre-downloads a count sheet (data + page) so it opens inside a walk-in with no signal. */
export function DownloadForOffline({ sessionId }: { sessionId: string }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => {
    idb.get<{ downloaded_at: string }>(STORES.sheets, sessionId).then((s) => setSaved(s?.downloaded_at ?? null)).catch(() => undefined);
  }, [sessionId]);
  async function download() {
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("get_count_sheet", { p_session: sessionId });
      if (error) throw error;
      const at = new Date().toISOString();
      await idb.put(STORES.sheets, { session_id: sessionId, sheet: data, downloaded_at: at });
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.active?.postMessage({ type: "cache-urls", urls: [`/counts/${sessionId}`, "/counts", "/offline"] });
      setSaved(at);
      toast({ tone: "success", text: "Saved to this device for offline counting" });
    } catch (e) {
      toast({ tone: "error", text: (e as Error).message || "Download failed" });
    } finally { setBusy(false); }
  }
  return (
    <Button size="sm" variant="ghost" onClick={download} disabled={busy} title={saved ? `Saved ${new Date(saved).toLocaleString()}` : undefined}>
      {busy ? "Saving…" : saved ? "✓ Saved to device" : "Download for offline"}
    </Button>
  );
}
