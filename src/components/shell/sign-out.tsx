"use client";
import { idb, STORES } from "@/lib/offline/idb";

/** Signs out, but first warns if counts are still waiting on this device (they would sync under the next user's login). */
export function SignOutButton({ className }: { className?: string }) {
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const pending = await idb.count(STORES.queue).catch(() => 0);
    if (pending && !confirm(`${pending} count entr${pending === 1 ? "y is" : "ies are"} saved on this device but not synced yet. Connect to the internet and let them sync before signing out.\n\nSign out anyway?`)) return;
    const reg = await navigator.serviceWorker?.getRegistration().catch(() => undefined);
    reg?.active?.postMessage({ type: "clear-pages" });
    (e.target as HTMLFormElement).submit();
  }
  return (
    <form action="/auth/signout" method="post" onSubmit={onSubmit} className="contents">
      <button className={className ?? "w-full rounded px-2 py-1.5 text-left text-sm hover:bg-surface-2"}>Sign out</button>
    </form>
  );
}
