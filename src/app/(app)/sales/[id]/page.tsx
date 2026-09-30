import { notFound } from "next/navigation";
import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/client";
import { Badge, Card, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { dateFmt, money, pct } from "@/lib/format";
import { reverseImport } from "../actions";
import { MapItem } from "./map-item";

export default async function SalesImportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("sales.import");
  const supabase = await createClient();
  const [{ data: imp }, { data: lines }, { data: recipes }] = await Promise.all([
    supabase.from("sales_imports").select("*").eq("id", id).single(),
    supabase.from("sales_lines").select("*, menu:menu_items(name, recipe_id)").eq("import_id", id).order("net_sales", { ascending: false }),
    supabase.from("recipes").select("id, name").eq("active", true).order("name"),
  ]);
  if (!imp) notFound();
  const showCost = can(ctx, "reports.view_cost");
  const theoPct = Number(imp.net_sales) ? (Number(imp.theoretical_cost) / Number(imp.net_sales)) * 100 : null;
  return (
    <>
      <PageHeader back={{ href: "/sales", label: "Sales" }} title={`POS sales · ${dateFmt(imp.business_date)}`}
        subtitle={<><StatusBadge status={imp.status === "posted" ? "posted" : "cancelled"} label={imp.status} /> {imp.source} · {imp.file_name ?? ""}</>}
        actions={imp.status === "posted" ? <ActionButton variant="ghost" action={reverseImport.bind(null, id)} prompt="Why reverse this import?" confirm="Reverse this import? Theoretical depletion is backed out with correction transactions (the original records are kept)." confirmLabel="Reverse import">Reverse import</ActionButton> : null} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Stat label="Net sales" value={money(imp.net_sales)} />
        <Stat label="Guests" value={imp.guest_count} sub={imp.guest_count ? `${money(Number(imp.net_sales) / imp.guest_count)} / guest` : undefined} />
        <Stat label="Checks" value={imp.check_count} />
        {showCost ? <Stat label="Theoretical cost" value={money(imp.theoretical_cost)} sub={theoPct !== null ? pct(theoPct) + " of sales" : undefined} /> : null}
        <Stat label="Unmapped items" value={imp.unmapped_lines} tone={imp.unmapped_lines ? "warning" : undefined} />
      </div>
      <Card padded={false}>
        <table className="tbl">
          <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Net sales</th><th className="num">Discounts</th><th className="num">Voids</th>{showCost ? <><th className="num">Recipe cost</th><th className="num">Theoretical</th><th className="num">Food cost %</th></> : null}<th>Recipe</th></tr></thead>
          <tbody>
            {(lines ?? []).map((l) => {
              const theo = l.recipe_cost ? Number(l.recipe_cost) * Number(l.quantity) : null;
              return (
                <tr key={l.id}>
                  <td className="font-medium">{l.item_name}{l.pos_item_id ? <span className="text-xs text-muted"> · {l.pos_item_id}</span> : null}</td>
                  <td className="num">{Number(l.quantity)}</td><td className="num">{money(l.net_sales)}</td><td className="num">{money(l.discounts)}</td><td className="num">{Number(l.voids) || "—"}</td>
                  {showCost ? <><td className="num">{money(l.recipe_cost, { precise: true })}</td><td className="num">{money(theo)}</td><td className="num">{theo && Number(l.net_sales) ? pct((theo / Number(l.net_sales)) * 100) : "—"}</td></> : null}
                  <td>{l.menu_item_id && (l.menu as { recipe_id: string | null } | null)?.recipe_id ? <Badge tone="success">Mapped</Badge>
                    : canOrg(ctx, "recipes.edit") ? <MapItem posItemId={l.pos_item_id} itemName={l.item_name} recipes={recipes ?? []} /> : <Badge tone="warning">Unmapped</Badge>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      {imp.unmapped_lines ? <p className="mt-2 text-xs text-muted">Mapping an item applies to future imports. To deplete this day&apos;s unmapped sales, map the items, reverse this import and import the file again.</p> : null}
    </>
  );
}
