import Link from "next/link";
import { requireContext, can, orderingEnabled } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/client";
import { Badge, Card, LinkButton, Notice, PageHeader, Stat } from "@/components/ui";
import { dateFmt, money, pct, qty } from "@/lib/format";
import { Boxes, ClipboardList, Trash2, Truck, ShoppingCart } from "lucide-react";
import { ackAlert } from "./tasks/actions";
import { Scorecard } from "./scorecard";
import { setupSteps, type SetupStatus } from "@/lib/setup";

export const metadata = { title: "Overview" };

type K = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default async function Dashboard({ searchParams }: { searchParams: Promise<{ region?: string; district?: string; market?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  const supabase = await createClient();
  // Operational alerts (late deliveries, unsubmitted orders, expiring lots, waste, variance) refresh before KPIs read them
  await supabase.rpc("refresh_operational_alerts", { p_location: ctx.location.id });
  const [{ data, error }, { data: setup }] = await Promise.all([
    supabase.rpc("dashboard_kpis", { p_location: ctx.location.id }),
    supabase.rpc("setup_status", { p_location: ctx.location.id }),
  ]);
  const setupTodo = setup && can(ctx, "inventory.settings") ? setupSteps(setup as SetupStatus).filter((s) => !s.later) : [];
  const setupDone = setupTodo.filter((s) => s.done).length;
  if (error) return <Notice tone="danger" title="Dashboard unavailable">{error.message}</Notice>;
  const k = data as K;
  const cost = can(ctx, "reports.view_cost");
  const fc = k.food_cost as K | null;
  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: ctx.location.timezone }));
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const corporate = ctx.locations.length > 1 && ctx.locations.some((l) => l.permissions.includes("reports.view_corporate"));
  const yest = k.sales_yesterday as K | null;
  const fcToday = k.forecast_today as K;
  const ordering = orderingEnabled(ctx);
  const wasteWeekPct = Number(k.sales_7d) ? (Number(k.waste_7d) / Number(k.sales_7d)) * 100 : null;

  return (
    <>
      <PageHeader title={`${greet}, ${(ctx.user.full_name ?? "").split(" ")[0]}`} subtitle={`#${ctx.location.code} ${ctx.location.name} · ${dateFmt(k.today)}`} />

      {setupTodo.length && setupDone < setupTodo.length ? (
        <Link href="/setup" className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-brand bg-brand-soft px-4 py-3" data-testid="setup-banner">
          <div><div className="font-semibold text-brand">Finish setting up · {setupDone} of {setupTodo.length} done</div>
            <div className="text-sm text-muted">Next: {setupTodo.find((s) => !s.done)!.title}</div></div>
          <span className="text-sm font-medium text-brand">Continue →</span>
        </Link>
      ) : null}
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {can(ctx, "inventory.count") ? <QuickAction href="/counts" icon={<ClipboardList className="h-6 w-6" />} label="Count inventory" sub={k.open_counts ? `${k.open_counts} open` : undefined} /> : null}
        {can(ctx, "orders.receive") ? <QuickAction href="/receiving" icon={<Truck className="h-6 w-6" />} label={ordering ? "Receive delivery" : "Log a delivery"} sub={ordering && k.pending_deliveries ? `${k.pending_deliveries} expected` : undefined} /> : null}
        {can(ctx, "waste.log") ? <QuickAction href="/waste" icon={<Trash2 className="h-6 w-6" />} label="Log waste" /> : null}
        {ordering && can(ctx, "orders.create") ? <QuickAction href="/purchasing" icon={<ShoppingCart className="h-6 w-6" />} label="What should I order?" /> : null}
        {!ordering && can(ctx, "inventory.view") ? <QuickAction href="/inventory" icon={<Boxes className="h-6 w-6" />} label="Stock on hand" sub={k.stock.low + k.stock.critical ? `${k.stock.low + k.stock.critical} running low` : undefined} /> : null}
      </div>

      {cost ? (
        <div className="mb-5 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
          <Stat label="Inventory value" value={money(k.inventory_value)} href="/inventory" />
          <Stat label="Actual food cost" value={fc?.actual_pct != null ? pct(fc.actual_pct) : "—"} sub={fc ? money(fc.actual_cost) : "Needs 2 posted counts"} href="/food-cost" />
          <Stat label="Theoretical food cost" value={fc?.theoretical_pct != null ? pct(fc.theoretical_pct) : "—"} sub={fc ? money(fc.theoretical_cost) : undefined} href="/food-cost" />
          <Stat label="AvT variance" value={fc ? money(fc.variance, { sign: true }) : "—"} tone={fc && Number(fc.variance) > 0 ? "danger" : undefined}
            sub={fc?.variance_pct_points != null ? `${Number(fc.variance_pct_points) > 0 ? "+" : ""}${fc.variance_pct_points} pts` : undefined} href="/food-cost" />
          <Stat label="Waste today / week" value={money(k.waste_today)} sub={`${money(k.waste_7d)} last 7 days${wasteWeekPct !== null ? ` · ${pct(wasteWeekPct)} of sales` : ""}`} href="/waste" />
          <Stat label="Sales yesterday" value={yest ? money(yest.net_sales) : "—"} sub={yest ? `${yest.guests} guests · ${yest.checks} checks` : "Not imported"} href="/sales" />
          <Stat label="Forecast today" value={money(fcToday?.net_sales)} sub={fcToday?.weeks_used ? `${fcToday.guest_count} guests · ${fcToday.weeks_used}-wk avg` : "No sales history"} />
          <Stat label="Inventory turns (28d)" value={k.turns_28d ?? "—"} sub="usage ÷ avg inventory" href="/reports?r=efficiency" />
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Needs attention" className="lg:col-span-2" padded={false}>
          <div className={`grid grid-cols-2 gap-px border-b border-border bg-border ${ordering ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
            <Attn label="Low / critical" value={`${k.stock.low} / ${k.stock.critical}`} href="/inventory" tone={k.stock.critical ? "danger" : k.stock.low ? "warning" : undefined} />
            <Attn label="Out / negative" value={`${k.stock.out} / ${k.stock.negative}`} href="/inventory" tone={k.stock.out + k.stock.negative ? "danger" : undefined} />
            {ordering ? <Attn label="Deliveries pending (late)" value={`${k.pending_deliveries} (${k.late_deliveries})`} href="/receiving" tone={k.late_deliveries ? "danger" : undefined} /> : null}
            <Attn label="Invoices to reconcile" value={k.to_reconcile} href="/receiving" tone={k.to_reconcile ? "warning" : undefined} />
            {ordering ? <Attn label="Draft orders" value={k.open_pos} href="/purchasing" /> : null}
            <Attn label="Open counts" value={k.open_counts} href="/counts" />
            <Attn label="Tasks due today" value={k.tasks.due_today} href="/tasks" tone={k.tasks.due_today ? "warning" : undefined} />
            <Attn label="Overdue tasks" value={k.tasks.overdue} href="/tasks" tone={k.tasks.overdue ? "danger" : undefined} />
          </div>
          <ul className="divide-y divide-border">
            {(k.alerts as K[]).map((a) => (
              <li key={a.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium"><Badge tone={a.severity === "critical" ? "danger" : a.severity === "warning" ? "warning" : "info"}>{a.severity}</Badge>
                    {a.product_id ? <Link href={`/inventory/items/${a.product_id}`} className="truncate hover:text-brand">{a.title}</Link> : <span className="truncate">{a.title}</span>}</div>
                  {a.message ? <div className="mt-0.5 text-xs text-muted">{a.message}</div> : null}
                </div>
                <ActionButton size="sm" variant="ghost" action={ackAlert.bind(null, a.id, false)}>Acknowledge</ActionButton>
              </li>
            ))}
            {!(k.alerts as K[]).length ? <li className="px-4 py-6 text-center text-sm text-muted">No open alerts. Nice.</li> : null}
          </ul>
        </Card>
        <div className="space-y-4">
          {cost ? (
            <Card title="Largest inventory variances" actions={k.last_count ? <Link className="text-xs text-brand" href={`/counts/${k.last_count.id}/review`}>{k.last_count.name}</Link> : null}>
              {k.largest_variances?.length ? (
                <ul className="space-y-1.5 text-sm">{(k.largest_variances as K[]).map((v) => (
                  <li key={v.id} className="flex justify-between gap-2"><Link className="truncate hover:text-brand" href={`/inventory/items/${v.id}?tab=stock`}>{v.name}</Link>
                    <span className="whitespace-nowrap tabular-nums text-danger">{qty(v.qty, v.unit)} · {money(v.value)}</span></li>
                ))}</ul>
              ) : <p className="text-sm text-muted">No losses on the last posted count.</p>}
            </Card>
          ) : null}
          {cost ? (
            <Card title="Top waste (7 days)" actions={<Link href="/waste" className="text-xs text-brand">Waste log</Link>}>
              {k.top_waste?.length ? <ul className="space-y-1.5 text-sm">{(k.top_waste as K[]).map((w) => <li key={w.name} className="flex justify-between"><span>{w.name}</span><span className="tabular-nums">{money(w.cost)}</span></li>)}</ul>
                : <p className="text-sm text-muted">No waste logged this week.</p>}
            </Card>
          ) : null}
          {cost ? (
            <Card title="Price increases">
              {k.price_increases?.length ? <ul className="space-y-1.5 text-sm">{(k.price_increases as K[]).map((p, i) => <li key={i}><div className="font-medium">{String(p.title).replace("Price increase: ", "")}</div><div className="text-xs text-muted">{p.message}</div></li>)}</ul>
                : <p className="text-sm text-muted">No unacknowledged price increases.</p>}
            </Card>
          ) : null}
        </div>
      </div>

      {cost && (k.forecast_week as K[])?.some((f) => Number(f.net_sales) > 0) ? (
        <Card title="Sales forecast — next 7 days" className="mt-4" padded={false}>
          {/* Phone: one row per day. Wider screens: seven columns. */}
          <div className="grid divide-y divide-border text-sm sm:grid-cols-7 sm:divide-x sm:divide-y-0 sm:text-center">
            {(k.forecast_week as K[]).map((f) => (
              <div key={f.date} className="flex items-baseline justify-between gap-3 px-4 py-2 sm:block sm:p-3">
                <div className="text-xs text-muted">{new Date(`${f.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "numeric", day: "numeric" })}</div>
                <div className="ml-auto font-semibold tabular-nums sm:ml-0 sm:mt-1">{money(f.net_sales)}</div>
                <div className="w-20 text-right text-xs text-muted sm:w-auto sm:text-center">{f.guest_count} guests</div>
              </div>
            ))}
          </div>
          <p className="border-t border-border px-4 py-2 text-xs text-muted">{(k.forecast_week as K[])[0]?.method}. {ordering ? "Suggested orders and dynamic pars use" : "Dynamic pars use"} this forecast.</p>
        </Card>
      ) : null}

      {corporate ? <Scorecard organizationId={ctx.organizationId} region={sp.region} district={sp.district} market={sp.market} /> : null}
      {!cost && can(ctx, "inventory.count") ? <div className="mt-4"><LinkButton href="/counts" variant="primary" size="lg">Go to counts</LinkButton></div> : null}
    </>
  );
}

function QuickAction({ href, icon, label, sub }: { href: string; icon: React.ReactNode; label: string; sub?: string }) {
  return (
    <Link href={href} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3 hover:border-brand">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand">{icon}</span>
      <span><span className="block text-sm font-semibold">{label}</span>{sub ? <span className="text-xs text-muted">{sub}</span> : null}</span>
    </Link>
  );
}

function Attn({ label, value, href, tone }: { label: string; value: React.ReactNode; href: string; tone?: "danger" | "warning" }) {
  return (
    <Link href={href} className="bg-surface px-4 py-3 hover:bg-surface-2">
      <div className="text-xs text-muted">{label}</div>
      <div className={`text-lg font-semibold tabular-nums ${tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : ""}`}>{value}</div>
    </Link>
  );
}
