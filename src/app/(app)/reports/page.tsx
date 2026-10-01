import Link from "next/link";
import { requirePermission, can, orderingEnabled } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { Card, Input, Notice, PageHeader, cx } from "@/components/ui";
import { todayIn } from "@/lib/format";

export const metadata = { title: "Reports" };

const REPORTS: { key: string; label: string; group: string; cost?: boolean; dated?: boolean; ordering?: boolean }[] = [
  { key: "valuation", label: "Inventory extended value", group: "Inventory", cost: true },
  { key: "efficiency", label: "Usage, turns, days on hand & aging", group: "Inventory", cost: true },
  { key: "counts", label: "Physical inventory summary", group: "Inventory", cost: true, dated: true },
  { key: "transactions", label: "Inventory transaction history", group: "Inventory", dated: true },
  { key: "adjustments", label: "Adjustment summary", group: "Inventory", dated: true },
  { key: "purchases", label: "Purchases by vendor / product / category", group: "Purchasing", cost: true, dated: true },
  { key: "price-variance", label: "Contract vs invoice price variance", group: "Purchasing", cost: true, dated: true },
  { key: "price-history", label: "Price changes", group: "Purchasing", cost: true, dated: true },
  { key: "vendors", label: "Vendor delivery & order accuracy", group: "Purchasing", dated: true, ordering: true },
  { key: "order-accuracy", label: "System suggestion vs manager order", group: "Purchasing", dated: true, ordering: true },
  { key: "lots", label: "Lot recall search", group: "Traceability" },
];
const LINKS = [
  { href: "/inventory", label: "Current inventory" }, { href: "/waste", label: "Waste summary" }, { href: "/transfers", label: "Transfer history" },
  { href: "/food-cost", label: "Actual vs theoretical" }, { href: "/counts", label: "Daily inventory counts" }, { href: "/inventory", label: "Stock cards (open an item)" },
];

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ r?: string; from?: string; to?: string; q?: string; type?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePermission("reports.view");
  const showCost = can(ctx, "reports.view_cost");
  const ordering = orderingEnabled(ctx);
  const available = REPORTS.filter((r) => (!r.cost || showCost) && (!r.ordering || ordering));
  const r = available.find((x) => x.key === sp.r) ?? available[0];
  const from = sp.from ?? todayIn(ctx.location.timezone, -30);
  const to = sp.to ?? todayIn(ctx.location.timezone);
  const groups = Array.from(new Set(available.map((x) => x.group)));
  return (
    <>
      <PageHeader title="Reports" subtitle={`#${ctx.location.code} ${ctx.location.name}`} />
      <div className="grid gap-4 lg:grid-cols-[15rem_1fr]">
        <nav className="no-print space-y-3">
          {groups.map((g) => (
            <div key={g}>
              <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">{g}</div>
              {available.filter((x) => x.group === g).map((x) => (
                <Link key={x.key} href={`?r=${x.key}&from=${from}&to=${to}`} className={cx("block rounded-md px-2 py-1.5 text-sm", x.key === r.key ? "bg-brand-soft font-medium text-brand" : "hover:bg-surface-2")}>{x.label}</Link>
              ))}
            </div>
          ))}
          <div>
            <div className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Elsewhere</div>
            {LINKS.map((l) => <Link key={l.label} href={l.href} className="block rounded-md px-2 py-1.5 text-sm hover:bg-surface-2">{l.label} →</Link>)}
          </div>
        </nav>
        <div className="min-w-0">
          <h2 className="mb-2 text-lg font-semibold">{r.label}</h2>
          {r.dated || r.key === "lots" || r.key === "transactions" ? (
            <form className="no-print mb-3 flex flex-wrap items-end gap-2 text-sm">
              <input type="hidden" name="r" value={r.key} />
              {r.dated ? <><label>From <Input type="date" name="from" defaultValue={from} className="h-9 w-40" /></label><label>To <Input type="date" name="to" defaultValue={to} className="h-9 w-40" /></label></> : null}
              {r.key === "lots" ? <Input name="q" defaultValue={sp.q} placeholder="Lot number or traceability code" className="h-9 w-72" /> : null}
              {r.key === "transactions" ? (
                <select name="type" defaultValue={sp.type ?? ""} className="h-9 rounded-md border border-border-strong bg-surface px-2">
                  <option value="">All transaction types</option>
                  {["RECEIPT", "POS_CONSUMPTION", "RECIPE_CONSUMPTION", "PRODUCTION", "WASTE", "TRANSFER_IN", "TRANSFER_OUT", "MANUAL_ADJUSTMENT", "PHYSICAL_VARIANCE", "RETURN_TO_VENDOR", "CORRECTION"].map((t) => <option key={t}>{t}</option>)}
                </select>
              ) : null}
              <button className="h-9 rounded-md border border-border-strong px-3">Run</button>
            </form>
          ) : null}
          <Report k={r.key} loc={ctx.location.id} from={from} to={to} q={sp.q} type={sp.type} showCost={showCost} tz={ctx.location.timezone} />
        </div>
      </div>
    </>
  );
}

async function Report({ k, loc, from, to, q, type, showCost, tz }: { k: string; loc: string; from: string; to: string; q?: string; type?: string; showCost: boolean; tz: string }) {
  const supabase = await createClient();
  const table = (rows: Record<string, unknown>[], columns: Column[], opts?: { sort?: { key: string; dir: 1 | -1 }; dense?: boolean }) =>
    <DataTable id={`report-${k}`} rows={rows} columns={columns} exportName={`report-${k}`} initialSort={opts?.sort} dense={opts?.dense} />;
  const endTs = new Date(`${to}T23:59:59`).toISOString();
  const startTs = new Date(`${from}T00:00:00`).toISOString();

  switch (k) {
    case "valuation": {
      const { data } = await supabase.from("current_inventory").select("product_id, product_number, product_name, category_name, inventory_unit, on_hand, unit_cost, extended_value").eq("location_id", loc).eq("active", true);
      const byCat = new Map<string, number>();
      for (const r of data ?? []) byCat.set(r.category_name ?? "Uncategorized", (byCat.get(r.category_name ?? "Uncategorized") ?? 0) + Number(r.extended_value));
      return (
        <div className="space-y-4">
          <Card title="By category" padded={false}>
            <table className="tbl"><tbody>{[...byCat.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => <tr key={c}><td>{c}</td><td className="num">{v.toLocaleString("en-US", { style: "currency", currency: "USD" })}</td></tr>)}</tbody></table>
          </Card>
          {table(data ?? [], [
            { key: "product_number", label: "#" }, { key: "product_name", label: "Product", href: "/inventory/items/{product_id}" }, { key: "category_name", label: "Category", filterable: true },
            { key: "on_hand", label: "On hand", format: "qty", unitKey: "inventory_unit" }, { key: "unit_cost", label: "Unit cost", format: "money4" }, { key: "extended_value", label: "Extended value", format: "money", total: true },
          ], { sort: { key: "extended_value", dir: -1 } })}
        </div>
      );
    }
    case "efficiency": {
      const { data, error } = await supabase.rpc("get_report_inventory_efficiency", { p_location: loc, p_days: 28 });
      if (error) return <Notice tone="danger">{error.message}</Notice>;
      return table(data ?? [], [
        { key: "product_name", label: "Product", href: "/inventory/items/{product_id}?tab=stock" }, { key: "category_name", label: "Category", filterable: true },
        { key: "on_hand", label: "On hand", format: "qty", unitKey: "inventory_unit" }, { key: "value", label: "Value", format: "money", total: true },
        { key: "usage_qty", label: "Usage (28d)", format: "qty", unitKey: "inventory_unit" }, { key: "usage_value", label: "Usage $", format: "money", total: true },
        { key: "avg_daily_usage", label: "Avg / day", format: "qty", unitKey: "inventory_unit" }, { key: "days_on_hand", label: "Days on hand", format: "number" },
        { key: "turns_annualized", label: "Turns / yr", format: "number" }, { key: "days_since_receipt", label: "Days since receipt", format: "number" },
        { key: "aging_flag", label: "Flag", filterable: true },
      ], { sort: { key: "days_on_hand", dir: -1 } });
    }
    case "counts": {
      const { data: sessions } = await supabase.from("count_sessions").select("id, count_number, name, count_type, count_at, status, posted_at").eq("location_id", loc).gte("count_at", startTs).lte("count_at", endTs).order("count_at", { ascending: false });
      const ids = (sessions ?? []).map((s) => s.id);
      const { data: lines } = ids.length ? await supabase.from("count_posting_lines").select("session_id, book_qty, physical_qty, unit_cost, variance_value, counted").in("session_id", ids) : { data: [] };
      const rows = (sessions ?? []).map((s) => {
        const ls = (lines ?? []).filter((l) => l.session_id === s.id);
        const physical = ls.reduce((a, l) => a + Number(l.physical_qty) * Number(l.unit_cost), 0);
        const variance = ls.reduce((a, l) => a + Number(l.variance_value), 0);
        return { ...s, items: ls.filter((l) => l.counted).length, physical_value: physical, variance, variance_pct: physical ? (variance / (physical - variance)) * 100 : null };
      });
      return table(rows, [
        { key: "name", label: "Count", href: "/counts/{id}/review" }, { key: "count_type", label: "Type", filterable: true }, { key: "count_at", label: "As of", format: "datetime" },
        { key: "status", label: "Status", filterable: true }, { key: "items", label: "Items counted", format: "number" },
        { key: "physical_value", label: "Physical value", format: "money" }, { key: "variance", label: "Variance $", format: "money", negativeRed: true, total: true }, { key: "variance_pct", label: "Variance %", format: "pct" },
      ]);
    }
    case "transactions": {
      let qb = supabase.from("inventory_transactions").select("id, txn_at, txn_type, quantity, unit_cost, extended_cost, reference, reason_code, notes, product_id, product:products(name, inventory_unit:units!products_inventory_unit_id_fkey(code)), who:profiles(full_name), storage:storage_locations(name)")
        .eq("location_id", loc).gte("txn_at", startTs).lte("txn_at", endTs).order("txn_at", { ascending: false }).limit(3000);
      if (type) qb = qb.eq("txn_type", type);
      const { data, error } = await qb;
      if (error) return <Notice tone="danger">{error.message}</Notice>;
      const rows = (data ?? []).map((t) => ({ ...t, product_name: (t.product as unknown as { name: string }).name, unit: (t.product as unknown as { inventory_unit: { code: string } }).inventory_unit.code,
        by: (t.who as unknown as { full_name: string } | null)?.full_name, storage_name: (t.storage as unknown as { name: string } | null)?.name }));
      return table(rows, [
        { key: "id", label: "Txn #", format: "text" }, { key: "txn_at", label: "When", format: "datetime" }, { key: "txn_type", label: "Type", filterable: true },
        { key: "product_name", label: "Product", href: "/inventory/items/{product_id}?tab=stock", filterable: false }, { key: "quantity", label: "Qty", format: "signedQty", unitKey: "unit", negativeRed: true },
        ...(showCost ? [{ key: "unit_cost", label: "Unit cost", format: "money4" as const }, { key: "extended_cost", label: "Value", format: "money" as const, total: true, negativeRed: true }] : []),
        { key: "storage_name", label: "Storage", filterable: true }, { key: "reference", label: "Reference" }, { key: "reason_code", label: "Reason", filterable: true }, { key: "by", label: "By", filterable: true },
      ], { dense: true });
    }
    case "adjustments": {
      const { data } = await supabase.from("inventory_transactions").select("id, txn_at, txn_type, quantity, extended_cost, reason_code, notes, product_id, product:products(name), who:profiles(full_name)")
        .eq("location_id", loc).in("txn_type", ["MANUAL_ADJUSTMENT", "CORRECTION"]).gte("txn_at", startTs).lte("txn_at", endTs).order("txn_at", { ascending: false });
      const rows = (data ?? []).map((t) => ({ ...t, product_name: (t.product as unknown as { name: string }).name, by: (t.who as unknown as { full_name: string } | null)?.full_name }));
      return table(rows, [
        { key: "txn_at", label: "When", format: "datetime" }, { key: "product_name", label: "Product", href: "/inventory/items/{product_id}?tab=stock" },
        { key: "reason_code", label: "Reason", filterable: true }, { key: "quantity", label: "Qty", format: "signedQty", negativeRed: true },
        ...(showCost ? [{ key: "extended_cost", label: "Value", format: "money" as const, total: true, negativeRed: true }] : []), { key: "notes", label: "Comment" }, { key: "by", label: "By", filterable: true },
      ]);
    }
    case "purchases":
    case "price-variance": {
      const { data, error } = await supabase.rpc("get_report_purchases", { p_location: loc, p_from: from, p_to: to });
      if (error) return <Notice tone="danger">{error.message}</Notice>;
      const rows = ((data ?? []) as Record<string, unknown>[]).filter((r) => k === "purchases" || Number(r.price_variance ?? 0) !== 0);
      return table(rows, [
        { key: "delivery_date", label: "Date", format: "date" }, { key: "vendor_name", label: "Vendor", filterable: true }, { key: "invoice_number", label: "Invoice", href: "/receiving/{receipt_id}" },
        { key: "product_name", label: "Product", href: "/inventory/items/{product_id}?tab=vendors" }, { key: "category_name", label: "Category", filterable: true },
        { key: "invoiced_qty", label: "Invoiced", format: "qty", unitKey: "unit_code" }, { key: "received_qty", label: "Received", format: "qty", unitKey: "unit_code", hidden: k === "price-variance" },
        { key: "contract_price", label: "Contract / PO price", format: "money" }, { key: "invoice_price", label: "Invoice price", format: "money" },
        { key: "price_variance", label: "Price variance $", format: "money", total: true, negativeRed: true }, { key: "extended", label: "Extended", format: "money", total: true },
        { key: "exceptions", label: "Exceptions", hidden: true },
      ], { sort: k === "price-variance" ? { key: "price_variance", dir: -1 } : { key: "delivery_date", dir: -1 } });
    }
    case "price-history": {
      const { data } = await supabase.from("price_history").select("effective_at, unit_price, base_unit_price, product_id, product:products(name), vendor:vendors(name), unit:units(code)")
        .eq("location_id", loc).gte("effective_at", new Date(new Date(startTs).getTime() - 90 * 86400000).toISOString()).lte("effective_at", endTs).order("effective_at");
      const last = new Map<string, number>();
      const rows: Record<string, unknown>[] = [];
      for (const p of data ?? []) {
        const prev = last.get(p.product_id);
        if (p.effective_at >= startTs) rows.push({ ...p, product_name: (p.product as unknown as { name: string }).name, vendor_name: (p.vendor as unknown as { name: string } | null)?.name,
          unit_code: (p.unit as unknown as { code: string } | null)?.code, previous: prev ?? null, change: prev ? Number(p.base_unit_price) - prev : null,
          change_pct: prev ? ((Number(p.base_unit_price) - prev) / prev) * 100 : null });
        last.set(p.product_id, Number(p.base_unit_price));
      }
      return table(rows, [
        { key: "effective_at", label: "Date", format: "date" }, { key: "product_name", label: "Product", href: "/inventory/items/{product_id}?tab=vendors" }, { key: "vendor_name", label: "Vendor", filterable: true },
        { key: "unit_price", label: "Price", format: "money" }, { key: "unit_code", label: "Per" }, { key: "base_unit_price", label: "Per inv. unit", format: "money4" },
        { key: "previous", label: "Previous", format: "money4" }, { key: "change", label: "Change $", format: "money4" }, { key: "change_pct", label: "Change %", format: "pct" },
      ], { sort: { key: "change_pct", dir: -1 } });
    }
    case "vendors": {
      const { data, error } = await supabase.rpc("get_report_vendor_performance", { p_location: loc, p_from: from, p_to: to });
      if (error) return <Notice tone="danger">{error.message}</Notice>;
      return table(data ?? [], [
        { key: "vendor_name", label: "Vendor" }, { key: "receipts", label: "Deliveries", format: "number" }, { key: "lines", label: "Lines", format: "number" },
        { key: "fill_rate_pct", label: "Fill rate", format: "pct" }, { key: "short_lines", label: "Short", format: "number" }, { key: "over_lines", label: "Over", format: "number" },
        { key: "back_orders", label: "Back orders", format: "number" }, { key: "substitutions", label: "Subs", format: "number" }, { key: "price_variance_lines", label: "Price ≠ contract", format: "number" },
        { key: "rejected_lines", label: "Rejected", format: "number" }, { key: "temp_failures", label: "Temp failures", format: "number" }, { key: "late_deliveries", label: "Late", format: "number" },
        ...(showCost ? [{ key: "invoice_over_short", label: "Invoice over/short", format: "money" as const }, { key: "purchases", label: "Purchases", format: "money" as const, total: true }] : []),
      ]);
    }
    case "order-accuracy": {
      const { data, error } = await supabase.rpc("get_report_order_accuracy", { p_location: loc, p_from: from, p_to: to });
      if (error) return <Notice tone="danger">{error.message}</Notice>;
      return table(data ?? [], [
        { key: "po_number", label: "PO", href: "/purchasing/{po_id}" }, { key: "vendor_name", label: "Vendor", filterable: true }, { key: "delivery_date", label: "Delivery", format: "date" },
        { key: "product_name", label: "Product" }, { key: "suggested_qty", label: "System", format: "qty", unitKey: "unit_code" }, { key: "ordered_qty", label: "Manager", format: "qty", unitKey: "unit_code" },
        { key: "difference", label: "Difference", format: "signedQty", unitKey: "unit_code" }, ...(showCost ? [{ key: "difference_value", label: "Difference $", format: "money" as const, total: true }] : []),
      ], { sort: { key: "difference", dir: -1 } });
    }
    case "lots": {
      if (!q) return <p className="text-sm text-muted">Enter a lot number to see every location, delivery and storage area that received it.</p>;
      const { data, error } = await supabase.rpc("search_lots", { p_query: q });
      if (error) return <Notice tone="danger">{error.message}</Notice>;
      return table(data ?? [], [
        { key: "lot_number", label: "Lot" }, { key: "traceability_lot_code", label: "TLC" }, { key: "product_name", label: "Product" }, { key: "vendor_name", label: "Vendor" },
        { key: "location_name", label: "Location", filterable: true }, { key: "storage_name", label: "Storage" }, { key: "receipt_number", label: "Receipt" },
        { key: "quantity", label: "Qty", format: "qty" }, { key: "received_at", label: "Received", format: "datetime" }, { key: "expiration_date", label: "Expires", format: "date" },
      ]);
    }
  }
  return <p className="text-sm text-muted">Unknown report ({tz}).</p>;
}
