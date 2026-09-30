"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { switchLocation } from "@/app/(app)/shell-actions";

export function LocationSwitcher({ locations, current }: { locations: { id: string; code: string; name: string }[]; current: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (locations.length <= 1) {
    const l = locations[0];
    return <span className="truncate text-sm font-medium">{l ? `#${l.code} ${l.name}` : ""}</span>;
  }
  return (
    <select aria-label="Location" value={current} disabled={pending}
      onChange={(e) => start(async () => { await switchLocation(e.target.value); router.refresh(); })}
      className="h-9 max-w-[14rem] truncate rounded-md border border-border-strong bg-surface px-2 text-sm font-medium">
      {locations.map((l) => <option key={l.id} value={l.id}>#{l.code} {l.name}</option>)}
    </select>
  );
}
