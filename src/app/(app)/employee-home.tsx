import Link from "next/link";
import { ArrowLeftRight, ClipboardList, ListChecks, Trash2, Truck } from "lucide-react";
import type { AppContext } from "@/lib/session";
import { actorName, can } from "@/lib/session";

type Dash = { tasks?: { due_today: number; overdue: number; upcoming: number }; open_counts?: number };

/** Intentionally simple home for front-line staff: four big buttons, no analytics. */
export function EmployeeHome({ ctx, dash }: { ctx: AppContext; dash: Dash | null }) {
  const due = (dash?.tasks?.due_today ?? 0) + (dash?.tasks?.overdue ?? 0);
  const actions = [
    can(ctx, "orders.receive") && { href: "/receiving", label: "Receive delivery", icon: <Truck className="h-8 w-8" />, sub: "Sysco, Greco, Commissary, other" },
    can(ctx, "waste.log") && { href: "/waste", label: "Log waste", icon: <Trash2 className="h-8 w-8" />, sub: "Dropped, expired, spoiled…" },
    can(ctx, "inventory.transfer") && { href: "/transfers", label: "Transfer product", icon: <ArrowLeftRight className="h-8 w-8" />, sub: "Move stock between areas" },
    { href: "/tasks", label: "My tasks", icon: <ListChecks className="h-8 w-8" />, sub: due ? `${due} due now` : "Nothing due" },
  ].filter(Boolean) as { href: string; label: string; icon: React.ReactNode; sub: string }[];
  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-5">
        <div className="text-xs font-semibold uppercase tracking-wider text-muted">Restaurant operations · #{ctx.location.code} {ctx.location.name}</div>
        <h1 className="mt-1 text-2xl font-semibold">Hi {actorName(ctx).split(" ")[0]}</h1>
      </div>
      <div className="grid gap-3 sm:grid-cols-2" data-testid="employee-home">
        {actions.map((a) => (
          <Link key={a.href} href={a.href} className="flex min-h-28 items-center gap-4 rounded-xl border border-border bg-surface p-5 hover:border-brand active:bg-surface-2">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">{a.icon}</span>
            <span><span className="block text-lg font-semibold uppercase tracking-wide">{a.label}</span><span className="text-sm text-muted">{a.sub}</span></span>
          </Link>
        ))}
      </div>
      {can(ctx, "inventory.count") && dash?.open_counts ? (
        <Link href="/counts" className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-surface p-4 hover:border-brand">
          <ClipboardList className="h-6 w-6 text-brand" />
          <span className="font-medium">Inventory count in progress</span>
          <span className="ml-auto text-sm text-brand">Open →</span>
        </Link>
      ) : null}
    </div>
  );
}
