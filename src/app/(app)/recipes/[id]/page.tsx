import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, PageHeader, Select, Stat } from "@/components/ui";
import { money, pct, qty } from "@/lib/format";
import { RecipeFields } from "../recipe-fields";
import { addIngredient, removeIngredient, saveMenuItem, saveRecipe, updateIngredient } from "../actions";

export default async function RecipePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("recipes.view");
  const supabase = await createClient();
  const [{ data: recipe }, { data: breakdown }, { data: ings }, { data: unitCost }, { data: units }, { data: products }, { data: allRecipes }, { data: options }, { data: usedIn }, { data: menu }] = await Promise.all([
    supabase.from("recipes").select("*, unit:units(code)").eq("id", id).single(),
    supabase.rpc("get_recipe_cost_breakdown", { p_recipe: id, p_location: ctx.location.id }),
    supabase.from("recipe_ingredients").select("id, product_id, sub_recipe_id, quantity, unit_id, yield_pct").eq("recipe_id", id).order("sort").order("created_at"),
    supabase.rpc("get_recipe_unit_cost", { p_recipe: id, p_location: ctx.location.id }),
    supabase.from("units").select("id, code, name, dimension").eq("active", true).order("sort"),
    supabase.from("products").select("id, name, is_prepped").eq("active", true).order("name"),
    supabase.from("recipes").select("id, name, yield_unit_id").eq("active", true).neq("id", id).order("name"),
    supabase.from("product_unit_options").select("product_id, unit_id, unit_code"),
    supabase.from("recipe_ingredients").select("recipe:recipes!recipe_ingredients_recipe_id_fkey(id, name)").eq("sub_recipe_id", id),
    supabase.from("menu_items").select("*").eq("recipe_id", id),
  ]);
  if (!recipe) notFound();
  const edit = canOrg(ctx, "recipes.edit");
  const showCost = can(ctx, "reports.view_cost");
  const yu = (recipe.unit as { code: string }).code;
  const batch = Number(unitCost ?? 0) * Number(recipe.yield_qty);
  const mi = menu?.[0];
  const plate = Number(unitCost ?? 0) * Number(mi?.portion_qty ?? 1);
  const unitsFor = (ing: { product_id: string | null; sub_recipe_id: string | null }) =>
    ing.product_id ? (options ?? []).filter((o) => o.product_id === ing.product_id).map((o) => ({ id: o.unit_id, code: o.unit_code })) : (units ?? []).map((u) => ({ id: u.id, code: u.code }));
  return (
    <>
      <PageHeader back={{ href: "/recipes", label: "Recipes" }} title={recipe.name}
        subtitle={<>{recipe.recipe_type.replace("_", " ")} · yields {qty(recipe.yield_qty, yu)}{recipe.product_id ? <> · <Badge tone="brand">Inventoried prep item</Badge></> : null}{!recipe.active ? <> · <Badge tone="danger">Inactive</Badge></> : null}</>}
        actions={recipe.product_id && can(ctx, "production.log") ? <Link className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white" href={`/production?recipe=${id}`}>Record production</Link> : null} />
      {showCost ? (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="Batch cost" value={money(batch)} sub={`${qty(recipe.yield_qty, yu)}`} />
          <Stat label={`Cost per ${yu}`} value={money(unitCost, { precise: true })} />
          <Stat label="Selling price" value={money(mi?.selling_price)} sub={mi ? mi.name : "No menu item"} />
          <Stat label="Food cost %" value={mi?.selling_price ? pct((plate / Number(mi.selling_price)) * 100) : "—"} tone={mi?.selling_price && plate / Number(mi.selling_price) > 0.35 ? "warning" : undefined} />
          <Stat label="Margin" value={mi?.selling_price ? money(Number(mi.selling_price) - plate) : "—"} />
        </div>
      ) : null}
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card title="Ingredients" padded={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Ingredient</th><th className="num">Quantity</th><th className="num">Yield %</th>{showCost ? <><th className="num">Cost</th><th className="num">% of cost</th></> : null}<th /></tr></thead>
              <tbody>
                {(breakdown ?? []).map((b: { ingredient_id: string; kind: string; name: string; quantity: number; unit_code: string; yield_pct: number; cost: number }) => {
                  const ing = ings?.find((i) => i.id === b.ingredient_id)!;
                  return (
                    <tr key={b.ingredient_id}>
                      <td>{b.kind === "recipe" ? <Link className="font-medium text-brand" href={`/recipes/${ing.sub_recipe_id}`}>{b.name}</Link> : <Link className="text-text hover:text-brand" href={`/inventory/items/${ing.product_id}`}>{b.name}</Link>} {b.kind === "recipe" ? <Badge tone="info">Sub-recipe</Badge> : null}</td>
                      <td className="num">
                        {edit ? (
                          <ActionForm action={updateIngredient.bind(null, b.ingredient_id)} className="flex items-center justify-end gap-1">
                            <input name="quantity" defaultValue={Number(b.quantity)} inputMode="decimal" aria-label={`${b.name} quantity`} className="h-8 w-16 rounded border border-border-strong bg-surface px-2 text-right text-sm" />
                            <select name="unit_id" defaultValue={ing.unit_id} aria-label="Unit" className="h-8 rounded border border-border-strong bg-surface px-1 text-sm">{unitsFor(ing).map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}</select>
                            <input type="hidden" name="yield_pct" value={Number(b.yield_pct)} />
                            <SubmitButton size="sm" variant="ghost">Save</SubmitButton>
                          </ActionForm>
                        ) : qty(b.quantity, b.unit_code)}
                      </td>
                      <td className="num">{Number(b.yield_pct)}%</td>
                      {showCost ? <><td className="num">{money(b.cost, { precise: true })}</td><td className="num">{batch ? pct((Number(b.cost) / batch) * 100) : "—"}</td></> : null}
                      <td className="text-right">{edit ? <ActionButton size="sm" variant="ghost" action={removeIngredient.bind(null, b.ingredient_id)} confirm={`Remove ${b.name}?`}>✕</ActionButton> : null}</td>
                    </tr>
                  );
                })}
                {!breakdown?.length ? <tr><td colSpan={6} className="py-6 text-center text-muted">No ingredients yet</td></tr> : null}
              </tbody>
              {showCost && breakdown?.length ? <tfoot><tr className="font-semibold"><td colSpan={3}>Batch total{Number(recipe.prep_loss_pct) ? ` (incl. ${recipe.prep_loss_pct}% prep loss)` : ""}</td><td className="num">{money(batch)}</td><td /><td /></tr></tfoot> : null}
            </table>
          </div>
          {edit ? (
            <ActionForm action={addIngredient.bind(null, id)} resetOnSuccess className="border-t border-border p-4">
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Ingredient" className="min-w-56 flex-1">
                  <Select name="item" required defaultValue="">
                    <option value="" disabled>Choose product or sub-recipe…</option>
                    <optgroup label="Products">{(products ?? []).map((p) => <option key={p.id} value={`p:${p.id}`}>{p.name}</option>)}</optgroup>
                    <optgroup label="Sub-recipes">{(allRecipes ?? []).map((r) => <option key={r.id} value={`r:${r.id}`}>{r.name}</option>)}</optgroup>
                  </Select>
                </Field>
                <Field label="Qty" className="w-24"><Input name="quantity" inputMode="decimal" required /></Field>
                <Field label="Unit" className="w-28"><Select name="unit_id" required>{(units ?? []).map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}</Select></Field>
                <Field label="Usable yield %" className="w-28"><Input name="yield_pct" inputMode="decimal" defaultValue="100" /></Field>
                <input type="hidden" name="sort" value={(ings?.length ?? 0) + 1} />
                <SubmitButton size="md">Add</SubmitButton>
              </div>
              <p className="mt-2 text-xs text-muted">The unit must convert to the product (e.g. OZ for an LB product, or a package unit defined on the product). Invalid combinations are rejected.</p>
            </ActionForm>
          ) : null}
        </Card>
        <div className="space-y-4">
          <Card title="Menu item / POS mapping">
            <ActionForm action={saveMenuItem.bind(null, mi?.id ?? null, id)} className="space-y-2">
              <fieldset disabled={!edit} className="space-y-2">
                <Field label="Menu item name"><Input name="name" required defaultValue={mi?.name ?? recipe.name} /></Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="POS item id"><Input name="pos_item_id" defaultValue={mi?.pos_item_id ?? ""} /></Field>
                  <Field label="Price $"><Input name="selling_price" inputMode="decimal" defaultValue={mi?.selling_price ?? ""} /></Field>
                  <Field label="Menu category"><Input name="menu_category" defaultValue={mi?.menu_category ?? ""} /></Field>
                  <Field label={`Portion (${yu})`}><Input name="portion_qty" inputMode="decimal" defaultValue={mi?.portion_qty ?? "1"} /></Field>
                </div>
              </fieldset>
              {edit ? <SubmitButton size="sm">{mi ? "Save menu item" : "Create menu item"}</SubmitButton> : null}
            </ActionForm>
          </Card>
          <Card title="Used in">
            <ul className="space-y-1 text-sm">
              {(usedIn ?? []).map((u, i) => { const r = u.recipe as unknown as { id: string; name: string }; return <li key={i}><Link className="text-brand" href={`/recipes/${r.id}`}>{r.name}</Link></li>; })}
              {!usedIn?.length ? <li className="text-muted">Not used in other recipes</li> : null}
            </ul>
            {usedIn?.length ? <p className="mt-2 text-xs text-muted">Changing this recipe updates the cost of every recipe above.</p> : null}
          </Card>
        </div>
      </div>
      <Card title="Recipe details" className="mt-4">
        <ActionForm action={saveRecipe.bind(null, id)}>
          <RecipeFields recipe={recipe} units={units ?? []} products={(products ?? []).filter((p) => p.is_prepped || p.id === recipe.product_id)} disabled={!edit} />
          {edit ? <div className="mt-3 flex justify-end"><SubmitButton>Save recipe</SubmitButton></div> : null}
        </ActionForm>
      </Card>
    </>
  );
}
