import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { money } from "@/lib/format";

type Row = { location_id: string; code: string; name: string; region: string | null; district: string | null; market: string | null;
  net_sales: number; actual_cost: number; theoretical_cost: number; actual_pct: number | null; theoretical_pct: number | null; variance_pts: number | null;
  waste: number; waste_pct: number | null; count_variance: number; inventory_value: number; open_alerts: number };

/** Corporate view: which locations are performing, which have problems, and why (trailing 28 days). */
export async function Scorecard({ organizationId, region, district, market }: { organizationId: string; region?: string; district?: string; market?: string }) {
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_location_scorecard", { p_org: organizationId, p_days: 28 });
  const all = (data ?? []) as Row[];
  const rows = all.filter((r) => (!region || r.region === region) && (!district || r.district === district) && (!market || r.market === market));
  const opts = (k: "region" | "district" | "market") => Array.from(new Set(all.map((r) => r[k]).filter(Boolean))) as string[];
  const withSales = rows.filter((r) => r.actual_pct !== null);
  const pick = (f: (r: Row) => number, dir: 1 | -1) => [...withSales].sort((a, b) => (f(a) - f(b)) * dir)[0];
  const best = withSales.length > 1 ? pick((r) => Number(r.variance_pts ?? 99), 1) : withSales[0];
  const worst = withSales.length > 1 ? pick((r) => Number(r.variance_pts ?? -99), -1) : undefined;
  const waste = [...rows].sort((a, b) => Number(b.waste) - Number(a.waste))[0];
  const loss = [...rows].sort((a, b) => Number(b.count_variance) - Number(a.count_variance))[0];
  const label = (r?: Row) => (r ? `#${r.code} ${r.name}` : "—");
  return (
    <section className="mt-6">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <h2 className="text-sm font-semibold text-muted">ALL LOCATIONS · LAST 28 DAYS</h2>
        <form className="flex flex-wrap gap-2 text-sm">
          {(["region", "district", "market"] as const).map((k) => (
            <select key={k} name={k} defaultValue={{ region, district, market }[k] ?? ""} aria-label={k} className="h-9 rounded-md border border-border-strong bg-surface px-2">
              <option value="">All {k}s</option>{opts(k).map((o) => <option key={o}>{o}</option>)}
            </select>
          ))}
          <button className="h-9 rounded-md border border-border-strong px-3">Filter</button>
        </form>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Card><div className="text-xs text-muted">Best AvT</div><div className="font-semibold">{label(best)}</div><div className="text-xs">{best ? `${best.variance_pts ?? "—"} pts` : ""}</div></Card>
        <Card><div className="text-xs text-muted">Worst AvT</div><div className="font-semibold text-danger">{label(worst)}</div><div className="text-xs">{worst ? `${worst.variance_pts ?? "—"} pts` : ""}</div></Card>
        <Card><div className="text-xs text-muted">Highest waste</div><div className="font-semibold">{label(waste)}</div><div className="text-xs">{waste ? money(waste.waste) : ""}</div></Card>
        <Card><div className="text-xs text-muted">Largest inventory variance</div><div className="font-semibold">{label(loss)}</div><div className="text-xs">{loss ? money(loss.count_variance) : ""}</div></Card>
      </div>
      <DataTable id="scorecard" rows={rows.map((r) => ({ ...r, store: `#${r.code} ${r.name}` }))} exportName="location-scorecard" initialSort={{ key: "variance_pts", dir: -1 }} columns={[
        { key: "store", label: "Store" }, { key: "region", label: "Region", filterable: true }, { key: "district", label: "District", hidden: true }, { key: "market", label: "Market", hidden: true },
        { key: "net_sales", label: "Net sales", format: "money", total: true }, { key: "actual_pct", label: "Actual %", format: "pct" }, { key: "theoretical_pct", label: "Theo %", format: "pct" },
        { key: "variance_pts", label: "AvT pts", format: "number" }, { key: "waste", label: "Waste", format: "money", total: true }, { key: "waste_pct", label: "Waste %", format: "pct" },
        { key: "count_variance", label: "Count loss", format: "money", total: true }, { key: "inventory_value", label: "Inventory", format: "money", total: true }, { key: "open_alerts", label: "Alerts", format: "number" },
      ]} />
      <p className="mt-1 text-xs text-muted">Switch location with the selector at the top to drill into a store.</p>
    </section>
  );
}
