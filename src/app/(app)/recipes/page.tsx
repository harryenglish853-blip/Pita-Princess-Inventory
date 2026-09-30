import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { LinkButton, PageHeader } from "@/components/ui";

export const metadata = { title: "Recipes & menu" };

export default async function RecipesPage() {
  const ctx = await requirePermission("recipes.view");
  const supabase = await createClient();
  const [{ data: recipes }, { data: menu }] = await Promise.all([
    supabase.from("recipes").select("id, name, recipe_type, yield_qty, active, product_id, unit:units(code)").order("name"),
    supabase.from("menu_items").select("id, name, pos_item_id, selling_price, portion_qty, recipe_id, active"),
  ]);
  const { data: costRows } = await supabase.rpc("recipe_costs", { p_location: ctx.location.id });
  const costOf = new Map(((costRows ?? []) as { recipe_id: string; unit_cost: number }[]).map((c) => [c.recipe_id, Number(c.unit_cost)]));
  const showCost = can(ctx, "reports.view_cost");
  const rows = (recipes ?? []).map((r) => {
    const unitCost = costOf.get(r.id) ?? 0;
    const mi = (menu ?? []).find((m) => m.recipe_id === r.id);
    const plateCost = unitCost * Number(mi?.portion_qty ?? 1);
    const price = mi?.selling_price ? Number(mi.selling_price) : null;
    return {
      id: r.id, name: r.name, type: r.recipe_type.replace("_", " "), yield: `${Number(r.yield_qty)} ${(r.unit as unknown as { code: string }).code}`,
      batch_cost: unitCost * Number(r.yield_qty), unit_cost: unitCost, menu_item: mi?.name ?? null, pos_item_id: mi?.pos_item_id ?? null,
      price, food_cost_pct: price ? (plateCost / price) * 100 : null, margin: price ? price - plateCost : null,
      inventoried: r.product_id ? "Yes" : "No", status: r.active ? "Active" : "Inactive",
    };
  });
  return (
    <>
      <PageHeader title="Recipes & menu" subtitle="Costs update automatically from current ingredient costs, through every nested sub-recipe"
        actions={canOrg(ctx, "recipes.edit") ? <LinkButton variant="primary" href="/recipes/new">New recipe</LinkButton> : null} />
      <DataTable id="recipes" rows={rows} exportName="recipes" columns={[
        { key: "name", label: "Recipe", href: "/recipes/{id}" },
        { key: "type", label: "Type", filterable: true },
        { key: "yield", label: "Yield" },
        ...(showCost ? [
          { key: "batch_cost", label: "Batch cost", format: "money" as const },
          { key: "unit_cost", label: "Cost / yield unit", format: "money4" as const },
        ] : []),
        { key: "menu_item", label: "Menu item" },
        { key: "pos_item_id", label: "POS id", hidden: true },
        { key: "price", label: "Price", format: "money" },
        ...(showCost ? [
          { key: "food_cost_pct", label: "Food cost %", format: "pct" as const },
          { key: "margin", label: "Margin", format: "money" as const },
        ] : []),
        { key: "inventoried", label: "Prepped inventory", filterable: true },
        { key: "status", label: "Status", filterable: true },
      ]} />
    </>
  );
}
