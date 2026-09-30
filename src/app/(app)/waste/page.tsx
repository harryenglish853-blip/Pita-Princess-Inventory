import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, Stat, Card } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { money, todayIn } from "@/lib/format";
import { WasteForm } from "./waste-form";

export const metadata = { title: "Waste" };

export default async function WastePage() {
  const ctx = await requirePermission("waste.log");
  const supabase = await createClient();
  const today = todayIn(ctx.location.timezone);
  const weekAgo = todayIn(ctx.location.timezone, -6);
  const [{ data: products }, { data: recipes }, { data: options }, { data: reasons }, { data: storages }, { data: logs }] = await Promise.all([
    supabase.from("current_inventory").select("product_id, product_name, inventory_unit, unit_cost").eq("location_id", ctx.location.id).eq("active", true).order("product_name"),
    supabase.from("recipes").select("id, name, yield_unit_id, product_id, unit:units(code)").eq("active", true).order("name"),
    supabase.from("product_unit_options").select("product_id, unit_id, unit_code, factor").order("factor"),
    supabase.from("adjustment_reasons").select("code, name, requires_comment").eq("kind", "waste").eq("active", true).order("sort"),
    supabase.from("storage_locations").select("id, name").eq("location_id", ctx.location.id).eq("active", true).order("sort_order"),
    supabase.from("waste_logs").select("id, business_date, wasted_at, quantity, reason_code, comment, total_cost, product:products(name), recipe:recipes(name), unit:units(code), who:profiles(full_name)")
      .eq("location_id", ctx.location.id).gte("business_date", todayIn(ctx.location.timezone, -30)).order("wasted_at", { ascending: false }),
  ]);
  const showCost = can(ctx, "reports.view_cost");
  const rows = (logs ?? []).map((l) => ({
    ...l, item: (l.product as unknown as { name: string } | null)?.name ?? `${(l.recipe as unknown as { name: string } | null)?.name} (prepared)`,
    unit_code: (l.unit as unknown as { code: string }).code, by: (l.who as unknown as { full_name: string } | null)?.full_name,
    reason: reasons?.find((r) => r.code === l.reason_code)?.name ?? l.reason_code,
  }));
  const sum = (from: string) => rows.filter((r) => r.business_date >= from).reduce((s, r) => s + Number(r.total_cost), 0);
  const byItem = new Map<string, number>();
  for (const r of rows.filter((x) => x.business_date >= weekAgo)) byItem.set(r.item, (byItem.get(r.item) ?? 0) + Number(r.total_cost));
  const top = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const byReason = new Map<string, number>();
  for (const r of rows.filter((x) => x.business_date >= weekAgo)) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + Number(r.total_cost));
  return (
    <>
      <PageHeader title="Waste" subtitle="Log it the moment it happens — it takes five seconds" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <WasteForm
          products={(products ?? []).map((p) => ({ id: p.product_id, name: p.product_name, unit: p.inventory_unit }))}
          recipes={(recipes ?? []).map((r) => ({ id: r.id, name: r.name, unit_id: r.yield_unit_id, unit: (r.unit as unknown as { code: string }).code }))}
          units={(options ?? []).map((o) => ({ product_id: o.product_id, unit_id: o.unit_id, code: o.unit_code }))}
          reasons={reasons ?? []} storages={storages ?? []} canBackdate={can(ctx, "inventory.adjust")} />
        <div className="space-y-4">
          {showCost ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Waste today" value={money(sum(today))} />
              <Stat label="Waste last 7 days" value={money(sum(weekAgo))} />
              <Stat label="Waste last 30 days" value={money(sum(todayIn(ctx.location.timezone, -30)))} />
            </div>
          ) : null}
          {showCost ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card title="Top waste items (7 days)">
                <ul className="space-y-1 text-sm">{top.map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="tabular-nums">{money(v)}</span></li>)}{!top.length ? <li className="text-muted">No waste logged</li> : null}</ul>
              </Card>
              <Card title="By reason (7 days)">
                <ul className="space-y-1 text-sm">{[...byReason.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => <li key={k} className="flex justify-between"><span>{k}</span><span className="tabular-nums">{money(v)}</span></li>)}{!byReason.size ? <li className="text-muted">No waste logged</li> : null}</ul>
              </Card>
            </div>
          ) : null}
          <DataTable id="waste" rows={rows} exportName="waste-log" initialSort={{ key: "wasted_at", dir: -1 }} columns={[
            { key: "wasted_at", label: "When", format: "datetime" },
            { key: "item", label: "Item" },
            { key: "quantity", label: "Qty", format: "qty", unitKey: "unit_code" },
            { key: "reason", label: "Reason", filterable: true },
            ...(showCost ? [{ key: "total_cost", label: "Cost", format: "money" as const, total: true }] : []),
            { key: "by", label: "Employee", filterable: true },
            { key: "comment", label: "Comment", hidden: true },
          ]} />
        </div>
      </div>
    </>
  );
}
