import Link from "next/link";
import { requirePermission } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Card, EmptyState, Notice, PageHeader, Stat, TabLinks } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { dateFmt, dateTimeFmt, money, pct } from "@/lib/format";

export const metadata = { title: "Food cost (AvT)" };

type Summary = Record<string, number | string | null>;
type AvtRow = {
  product_id: string; product_name: string; category_name: string | null; cost_group: string; inventory_unit: string;
  begin_qty: number; received_qty: number; transfer_qty: number; produced_qty: number; theoretical_qty: number; waste_qty: number;
  adjusted_qty: number; expected_end_qty: number; physical_end_qty: number; variance_qty: number; unit_cost: number;
  variance_value: number; theoretical_value: number; counted: boolean;
};

const GROUPS: Record<string, string[]> = { food: ["food"], beverage: ["beverage"], alcohol: ["alcohol"], "food+bev": ["food", "beverage", "alcohol"], all: ["food", "beverage", "alcohol", "paper", "supplies", "other"] };

export default async function FoodCostPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string; group?: string; view?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePermission("reports.view_cost");
  const supabase = await createClient();
  const { data: counts } = await supabase.from("count_sessions").select("id, name, count_at, count_type").eq("location_id", ctx.location.id).eq("status", "posted").order("count_at", { ascending: false }).limit(40);
  if (!counts || counts.length < 2) {
    return (
      <>
        <PageHeader title="Actual vs theoretical food cost" />
        <EmptyState title="Two posted counts are needed">Actual food cost is Begin inventory + Purchases − End inventory, so the period runs from one posted physical count to the next.</EmptyState>
      </>
    );
  }
  const toC = counts.find((c) => c.id === sp.to) ?? counts[0];
  const fromC = counts.find((c) => c.id === sp.from) ?? counts.find((c) => c.count_at < toC.count_at) ?? counts[1];
  const group = GROUPS[sp.group ?? "food"] ? sp.group ?? "food" : "food";
  const view = sp.view ?? "summary";
  const [{ data: summary, error }, { data: avt }] = await Promise.all([
    supabase.rpc("food_cost_summary", { p_location: ctx.location.id, p_from: fromC.count_at, p_to: toC.count_at, p_cost_groups: GROUPS[group] }),
    supabase.rpc("avt_by_product", { p_location: ctx.location.id, p_from: fromC.count_at, p_to: toC.count_at }),
  ]);
  if (error) return <Notice tone="danger">{error.message}</Notice>;
  const s = summary as Summary;
  const rows = ((avt ?? []) as AvtRow[]).filter((r) => GROUPS[group].includes(r.cost_group));
  const link = (o: Record<string, string>) => `?${new URLSearchParams({ from: fromC.id, to: toC.id, group, view, ...o })}`;
  const n = (k: string) => Number(s[k] ?? 0);
  const noSales = !n("net_sales");

  const byCat = new Map<string, { theo: number; variance: number; waste: number }>();
  for (const r of rows) {
    const k = r.category_name ?? "Uncategorized";
    const e = byCat.get(k) ?? { theo: 0, variance: 0, waste: 0 };
    e.theo += Number(r.theoretical_value); e.variance += Number(r.variance_value); e.waste += Number(r.waste_qty) * Number(r.unit_cost);
    byCat.set(k, e);
  }

  return (
    <>
      <PageHeader title="Actual vs theoretical food cost" subtitle={`#${ctx.location.code} ${ctx.location.name} · ${dateTimeFmt(fromC.count_at, ctx.location.timezone)} → ${dateTimeFmt(toC.count_at, ctx.location.timezone)}`} />
      <form className="mb-4 flex flex-wrap items-end gap-2 text-sm">
        <label>From count<select name="from" defaultValue={fromC.id} className="ml-1 h-9 rounded-md border border-border-strong bg-surface px-2">{counts.map((c) => <option key={c.id} value={c.id}>{c.name} · {dateFmt(c.count_at)}</option>)}</select></label>
        <label>To count<select name="to" defaultValue={toC.id} className="ml-1 h-9 rounded-md border border-border-strong bg-surface px-2">{counts.map((c) => <option key={c.id} value={c.id}>{c.name} · {dateFmt(c.count_at)}</option>)}</select></label>
        <label>Cost group<select name="group" defaultValue={group} className="ml-1 h-9 rounded-md border border-border-strong bg-surface px-2">{Object.keys(GROUPS).map((g) => <option key={g}>{g}</option>)}</select></label>
        <input type="hidden" name="view" value={view} />
        <button className="h-9 rounded-md border border-border-strong px-3">Apply</button>
      </form>
      {noSales ? <div className="mb-4"><Notice tone="warning" title="No POS sales in this period">Food cost percentages and theoretical cost need imported sales. Actual usage below is still exact.</Notice></div> : null}

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Net sales" value={money(n("net_sales"))} sub={`${s.sales_days ?? 0} days · ${s.guests ?? 0} guests`} />
        <Stat label="Actual food cost" value={money(n("actual_cost"))} sub={pct(s.actual_pct as number)} />
        <Stat label="Theoretical food cost" value={money(n("theoretical_cost"))} sub={pct(s.theoretical_pct as number)} />
        <Stat label="AvT variance" value={money(n("variance"), { sign: true })} tone={n("variance") > 0 ? "danger" : "success"} sub={s.variance_pct_points !== null ? `${Number(s.variance_pct_points) > 0 ? "+" : ""}${s.variance_pct_points} pts` : undefined} />
        <Stat label="Waste" value={money(n("waste"))} sub={s.waste_pct !== null ? pct(s.waste_pct as number) + " of sales" : undefined} />
        <Stat label="Count variance (loss)" value={money(n("count_variance"))} tone={n("count_variance") > 0 ? "danger" : undefined} />
        <Stat label="Purchases" value={money(n("purchases"))} />
        <Stat label="Ending inventory" value={money(n("end_inventory"))} sub={`Begin ${money(n("begin_inventory"))}`} />
      </div>

      <TabLinks active={view} tabs={[
        { key: "summary", label: "Summary", href: link({ view: "summary" }) },
        { key: "products", label: "By product", href: link({ view: "products" }) },
        { key: "categories", label: "By category", href: link({ view: "categories" }) },
        { key: "menu", label: "By menu item", href: link({ view: "menu" }) },
        { key: "days", label: "By day", href: link({ view: "days" }) },
      ]} />

      {view === "summary" ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="How actual cost is calculated">
            <table className="tbl">
              <tbody>
                <tr><td>Beginning inventory ({dateFmt(fromC.count_at)})</td><td className="num">{money(n("begin_inventory"))}</td></tr>
                <tr><td>+ Purchases (posted receipts)</td><td className="num">{money(n("purchases"))}</td></tr>
                <tr><td>± Transfers</td><td className="num">{money(n("transfers"))}</td></tr>
                <tr><td>− Ending inventory ({dateFmt(toC.count_at)})</td><td className="num">{money(-n("end_inventory"))}</td></tr>
                <tr className="font-semibold"><td>= ACTUAL USAGE</td><td className="num">{money(n("actual_cost"))}</td></tr>
              </tbody>
            </table>
          </Card>
          <Card title="Where the actual cost went">
            <table className="tbl">
              <tbody>
                <tr><td>Theoretical (items sold × current recipe cost)</td><td className="num">{money(n("theoretical_cost"))}</td></tr>
                <tr><td>POS depletion as posted (cost at time of sale)</td><td className="num text-muted">{money(n("pos_usage_at_post"))}</td></tr>
                <tr><td>Recorded waste</td><td className="num">{money(n("waste"))}</td></tr>
                <tr><td>Unexplained loss (physical count variance)</td><td className="num">{money(n("count_variance"))}</td></tr>
                <tr><td>Manual adjustments / corrections</td><td className="num">{money(n("adjustments"))}</td></tr>
                <tr><td>Production (ingredients used − prep produced)</td><td className="num">{money(n("production_net"))}</td></tr>
                <tr className="font-semibold"><td>ACTUAL − THEORETICAL</td><td className={`num ${n("variance") > 0 ? "text-danger" : "text-success"}`}>{money(n("variance"), { sign: true })}</td></tr>
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">Every figure is summed from the inventory transaction ledger and POS imports for the period, so it can be reproduced line by line from the stock cards.</p>
          </Card>
          <Card title="Largest losses (highest impact first)" className="lg:col-span-2" padded={false}>
            <table className="tbl">
              <thead><tr><th>Product</th><th className="num">Variance</th><th className="num">Loss $</th></tr></thead>
              <tbody>
                {[...rows].sort((a, b) => Number(a.variance_value) - Number(b.variance_value)).slice(0, 8).map((r) => (
                  <tr key={r.product_id}><td><Link className="text-brand" href={`/inventory/items/${r.product_id}?tab=stock`}>{r.product_name}</Link></td>
                    <td className="num">{Number(r.variance_qty).toLocaleString("en-US", { maximumFractionDigits: 2 })} {r.inventory_unit}</td>
                    <td className={`num font-semibold ${Number(r.variance_value) < 0 ? "text-danger" : ""}`}>{money(r.variance_value)}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      ) : null}

      {view === "products" ? (
        <DataTable id="avt-products" exportName="avt-by-product" rows={rows as unknown as Record<string, unknown>[]} initialSort={{ key: "variance_value", dir: 1 }} columns={[
          { key: "product_name", label: "Product", href: "/inventory/items/{product_id}?tab=stock" },
          { key: "category_name", label: "Category", filterable: true },
          { key: "begin_qty", label: "Beginning", format: "qty", unitKey: "inventory_unit" },
          { key: "received_qty", label: "Received", format: "qty", unitKey: "inventory_unit" },
          { key: "transfer_qty", label: "Transfers", format: "signedQty", unitKey: "inventory_unit", hidden: true },
          { key: "produced_qty", label: "Produced", format: "qty", unitKey: "inventory_unit", hidden: true },
          { key: "theoretical_qty", label: "Theoretical use", format: "qty", unitKey: "inventory_unit" },
          { key: "waste_qty", label: "Waste", format: "qty", unitKey: "inventory_unit" },
          { key: "adjusted_qty", label: "Adjusted", format: "signedQty", unitKey: "inventory_unit", hidden: true },
          { key: "expected_end_qty", label: "Expected ending", format: "qty", unitKey: "inventory_unit" },
          { key: "physical_end_qty", label: "Physical", format: "qty", unitKey: "inventory_unit" },
          { key: "variance_qty", label: "Variance", format: "signedQty", unitKey: "inventory_unit", negativeRed: true },
          { key: "unit_cost", label: "Cost", format: "money4" },
          { key: "variance_value", label: "Loss $", format: "money", negativeRed: true, total: true },
          { key: "theoretical_value", label: "Theoretical $", format: "money", total: true, hidden: true },
        ]} />
      ) : null}

      {view === "categories" ? (
        <Card padded={false}>
          <table className="tbl">
            <thead><tr><th>Category</th><th className="num">Theoretical usage $</th><th className="num">Waste $</th><th className="num">Count variance $</th></tr></thead>
            <tbody>{[...byCat.entries()].sort((a, b) => a[1].variance - b[1].variance).map(([k, v]) => (
              <tr key={k}><td className="font-medium">{k}</td><td className="num">{money(v.theo)}</td><td className="num">{money(v.waste)}</td><td className={`num ${v.variance < 0 ? "text-danger" : ""}`}>{money(v.variance)}</td></tr>
            ))}</tbody>
          </table>
        </Card>
      ) : null}

      {view === "menu" ? <MenuView locationId={ctx.location.id} from={fromC.count_at} to={toC.count_at} /> : null}
      {view === "days" ? <DayView locationId={ctx.location.id} from={fromC.count_at} to={toC.count_at} /> : null}
    </>
  );
}

async function MenuView({ locationId, from, to }: { locationId: string; from: string; to: string }) {
  const supabase = await createClient();
  const { data: imports } = await supabase.from("sales_imports").select("id, business_date").eq("location_id", locationId).eq("status", "posted")
    .gte("business_date", from.slice(0, 10)).lte("business_date", to.slice(0, 10));
  const ids = (imports ?? []).map((i) => i.id);
  const { data: lines } = ids.length ? await supabase.from("sales_lines").select("item_name, quantity, net_sales, recipe_cost, menu_item_id").in("import_id", ids) : { data: [] };
  const m = new Map<string, { item: string; qty: number; sales: number; theo: number; mapped: boolean }>();
  for (const l of lines ?? []) {
    const e = m.get(l.item_name) ?? { item: l.item_name, qty: 0, sales: 0, theo: 0, mapped: !!l.recipe_cost };
    e.qty += Number(l.quantity); e.sales += Number(l.net_sales); e.theo += Number(l.recipe_cost ?? 0) * Number(l.quantity);
    m.set(l.item_name, e);
  }
  const rows = [...m.values()].map((r) => ({ ...r, pct: r.sales ? (r.theo / r.sales) * 100 : null, mapped: r.mapped ? "Yes" : "No" }));
  return <DataTable id="avt-menu" exportName="menu-mix" rows={rows} initialSort={{ key: "theo", dir: -1 }} columns={[
    { key: "item", label: "Menu item" }, { key: "qty", label: "Sold", format: "number", total: true }, { key: "sales", label: "Net sales", format: "money", total: true },
    { key: "theo", label: "Theoretical cost", format: "money", total: true }, { key: "pct", label: "Food cost %", format: "pct" }, { key: "mapped", label: "Recipe mapped", filterable: true },
  ]} />;
}

async function DayView({ locationId, from, to }: { locationId: string; from: string; to: string }) {
  const supabase = await createClient();
  const [{ data: sales }, { data: waste }] = await Promise.all([
    supabase.from("sales_imports").select("business_date, net_sales, theoretical_cost, guest_count").eq("location_id", locationId).eq("status", "posted").gte("business_date", from.slice(0, 10)).lte("business_date", to.slice(0, 10)),
    supabase.from("waste_logs").select("business_date, total_cost").eq("location_id", locationId).gte("business_date", from.slice(0, 10)).lte("business_date", to.slice(0, 10)),
  ]);
  const days = new Map<string, { date: string; sales: number; theo: number; waste: number; guests: number }>();
  for (const s of sales ?? []) { const e = days.get(s.business_date) ?? { date: s.business_date, sales: 0, theo: 0, waste: 0, guests: 0 }; e.sales += Number(s.net_sales); e.theo += Number(s.theoretical_cost); e.guests += s.guest_count; days.set(s.business_date, e); }
  for (const w of waste ?? []) { const e = days.get(w.business_date) ?? { date: w.business_date, sales: 0, theo: 0, waste: 0, guests: 0 }; e.waste += Number(w.total_cost); days.set(w.business_date, e); }
  const rows = [...days.values()].map((d) => ({ ...d, theo_pct: d.sales ? (d.theo / d.sales) * 100 : null, waste_pct: d.sales ? (d.waste / d.sales) * 100 : null }));
  return <DataTable id="avt-days" exportName="food-cost-by-day" rows={rows} initialSort={{ key: "date", dir: 1 }} columns={[
    { key: "date", label: "Day", format: "date" }, { key: "sales", label: "Net sales", format: "money", total: true }, { key: "guests", label: "Guests", format: "number", total: true },
    { key: "theo", label: "Theoretical cost", format: "money", total: true }, { key: "theo_pct", label: "Theo %", format: "pct" },
    { key: "waste", label: "Waste", format: "money", total: true }, { key: "waste_pct", label: "Waste %", format: "pct" },
  ]} />;
}
