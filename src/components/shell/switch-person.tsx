"use client";
import { idb, STORES } from "@/lib/offline/idb";
import { switchEmployee } from "@/app/who/actions";

/** Ends the current person's session. Warns first if their offline counts have not synced (they would sync under the next person). */
export function SwitchPersonButton({ name }: { name: string }) {
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    const pending = await idb.count(STORES.queue).catch(() => 0);
    if (pending && !confirm(`${pending} count entr${pending === 1 ? "y is" : "ies are"} saved on this device but not synced yet. Let them sync first so they stay under ${name}'s name.\n\nSwitch anyway?`)) {
      e.preventDefault();
    }
  }
  return (
    <form action={switchEmployee} onSubmit={onSubmit} className="flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-0.5 pl-3 pr-0.5 text-sm" data-testid="acting-employee">
      <span className="max-w-28 truncate font-medium">{name}</span>
      <button className="h-7 rounded-full bg-surface px-2.5 text-xs font-medium text-brand hover:bg-brand-soft">Switch</button>
    </form>
  );
}
