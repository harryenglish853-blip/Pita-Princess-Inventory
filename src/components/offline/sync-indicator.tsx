"use client";
import { useEffect, useState } from "react";
import { subscribeSync, type SyncStatus } from "@/lib/offline/count-sync";
import { cx } from "@/components/ui";

const LABEL = { synced: "Synced", syncing: "Syncing", offline: "Offline", error: "Sync error" } as const;

export function SyncIndicator({ compact }: { compact?: boolean }) {
  const [s, setS] = useState<SyncStatus>({ state: "synced", pending: 0 });
  useEffect(() => {
    const unsub = subscribeSync(setS);
    return () => { unsub(); };
  }, []);
  const dot = { synced: "bg-success", syncing: "bg-info animate-pulse", offline: "bg-warning", error: "bg-danger" }[s.state];
  return (
    <span title={s.lastError ?? (s.pending ? `${s.pending} count entr${s.pending === 1 ? "y" : "ies"} saved on this device` : "All counts saved to server")}
      className={cx("inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-xs font-medium", s.state === "error" && "text-danger")}
      data-testid="sync-status" data-state={s.state}>
      <span className={cx("h-2 w-2 rounded-full", dot)} />
      {compact ? null : <span className="hidden sm:inline">{LABEL[s.state]}</span>}
      {s.pending > 0 ? <span className="tabular-nums">· {s.pending}</span> : null}
    </span>
  );
}
