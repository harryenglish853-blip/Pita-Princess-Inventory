import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { LinkButton, PageHeader, Stat } from "@/components/ui";
import { money } from "@/lib/format";

export const metadata = { title: "Inventory" };

export default async function InventoryPage() {
  const ctx = await requirePermission("inventory.view");
  const supabase = await createClient();
  const { data: rows, error } = await supabase
    .from("current_inventory")
    .select("product_id, product_number, product_name, category_name, inventory_unit, on_hand, effective_par, par_mode, min_qty, unit_cost, extended_value, stock_status, last_counted_at, last_txn_at, active")
    .eq("location_id", ctx.location.id)
    .eq("active", true)
    .order("product_name");
  if (error) throw new Error(error.message);
  const showCost = can(ctx, "reports.view_cost");
  const items = rows ?? [];
  const value = items.reduce((s, r) => s + Number(r.extended_value ?? 0), 0);
  const count = (st: string) => items.filter((r) => r.stock_status === st).length;

  const columns: Column[] = [
    { key: "product_number", label: "#", className: "w-20" },
    { key: "product_name", label: "Product", href: "/inventory/items/{product_id}" },
    { key: "category_name", label: "Category", filterable: true },
    { key: "on_hand", label: "On hand", format: "qty", unitKey: "inventory_unit", negativeRed: true },
    { key: "effective_par", label: "Par", format: "qty", unitKey: "inventory_unit" },
    { key: "par_mode", label: "Par type", filterable: true, hidden: true },
    ...(showCost ? ([
      { key: "unit_cost", label: "Unit cost", format: "money4" },
      { key: "extended_value", label: "Value", format: "money", total: true },
    ] as Column[]) : []),
    { key: "stock_status", label: "Status", format: "status", filterable: true },
    { key: "last_counted_at", label: "Last counted", format: "datetime" },
    { key: "last_txn_at", label: "Last movement", format: "datetime", hidden: true },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Perpetual (book) inventory calculated from the transaction ledger"
        actions={
          <>
            {canOrg(ctx, "products.edit") ? <LinkButton href="/inventory/items/new" variant="primary">New product</LinkButton> : null}
            <LinkButton href="/inventory/categories">Categories & units</LinkButton>
            <LinkButton href="/inventory/storage">Storage & shelf order</LinkButton>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {showCost ? <Stat label="Inventory value" value={money(value)} sub={`${items.length} active items`} /> : <Stat label="Active items" value={items.length} />}
        <Stat label="Low stock" value={count("low")} tone={count("low") ? "warning" : undefined} />
        <Stat label="Critical" value={count("critical")} tone={count("critical") ? "danger" : undefined} />
        <Stat label="Out of stock" value={count("out")} tone={count("out") ? "danger" : undefined} />
        <Stat label="Negative (book)" value={count("negative")} tone={count("negative") ? "danger" : undefined} sub="Needs investigation" />
        <Stat label="Never counted" value={items.filter((r) => !r.last_counted_at).length} />
      </div>
      <DataTable id="inventory" columns={columns} rows={items} exportName="current-inventory" initialSort={{ key: "product_name", dir: 1 }} />
    </>
  );
}
