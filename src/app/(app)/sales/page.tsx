import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { PageHeader, TabLinks } from "@/components/ui";
import { todayIn } from "@/lib/format";
import { ImportForm } from "./import-form";

export const metadata = { title: "Sales / POS" };

export default async function SalesPage() {
  const ctx = await requirePermission("sales.import");
  const supabase = await createClient();
  const [{ data: imports }, { data: menu }] = await Promise.all([
    supabase.from("sales_imports").select("*").eq("location_id", ctx.location.id).order("business_date", { ascending: false }).limit(120),
    supabase.from("menu_items").select("name, pos_item_id, recipe_id").eq("active", true),
  ]);
  const showCost = can(ctx, "reports.view_cost");
  const rows = (imports ?? []).map((i) => ({ ...i, theo_pct: Number(i.net_sales) ? (Number(i.theoretical_cost) / Number(i.net_sales)) * 100 : null, avg_check: i.check_count ? Number(i.net_sales) / i.check_count : null }));
  return (
    <>
      <PageHeader title="Sales / Toast" subtitle="Toast sales drive theoretical usage: items sold × recipes" />
      <TabLinks active="imports" tabs={[{ key: "imports", label: "Daily sales", href: "/sales" }, { key: "toast", label: "Toast sync", href: "/sales/toast" }]} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,28rem)_1fr]">
        <ImportForm yesterday={todayIn(ctx.location.timezone, -1)} menu={(menu ?? []).map((m) => ({ name: m.name, pos_item_id: m.pos_item_id, mapped: !!m.recipe_id }))} />
        <DataTable id="sales-imports" rows={rows} exportName="sales" initialSort={{ key: "business_date", dir: -1 }} columns={[
          { key: "business_date", label: "Date", format: "date", href: "/sales/{id}" },
          { key: "source", label: "Source", filterable: true },
          { key: "net_sales", label: "Net sales", format: "money", total: true },
          { key: "guest_count", label: "Guests", format: "number", total: true },
          { key: "check_count", label: "Checks", format: "number" },
          { key: "avg_check", label: "Avg check", format: "money", hidden: true },
          ...(showCost ? [{ key: "theoretical_cost", label: "Theoretical cost", format: "money" as const, total: true }, { key: "theo_pct", label: "Theo %", format: "pct" as const }] : []),
          { key: "unmapped_lines", label: "Unmapped", format: "number" },
          { key: "status", label: "Status", filterable: true },
        ]} />
      </div>
    </>
  );
}
