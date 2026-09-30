import { Field, Input, Select, Textarea } from "@/components/ui";

type R = Record<string, unknown> | null;
const s = (r: R, k: string) => (r?.[k] === null || r?.[k] === undefined ? "" : String(r[k]));

export function RecipeFields({ recipe, units, products, disabled }: { recipe: R; units: { id: string; code: string; name: string }[]; products: { id: string; name: string }[]; disabled?: boolean }) {
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Recipe name" className="sm:col-span-2"><Input name="name" required defaultValue={s(recipe, "name")} /></Field>
      <Field label="Type"><Select name="recipe_type" defaultValue={s(recipe, "recipe_type") || "menu_item"}>
        <option value="menu_item">Menu item</option><option value="prep">Prep (made in-house)</option><option value="sub_recipe">Sub-recipe (sauce, dressing…)</option><option value="batch">Batch</option>
      </Select></Field>
      <Field label="Serving size"><Input name="serving_size" defaultValue={s(recipe, "serving_size")} placeholder="1 sandwich" /></Field>
      <Field label="Yield quantity"><Input name="yield_qty" inputMode="decimal" required defaultValue={s(recipe, "yield_qty") || "1"} /></Field>
      <Field label="Yield unit"><Select name="yield_unit_id" required defaultValue={s(recipe, "yield_unit_id")}>{units.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</Select></Field>
      <Field label="Production / prep loss %"><Input name="prep_loss_pct" inputMode="decimal" defaultValue={s(recipe, "prep_loss_pct") || "0"} /></Field>
      <Field label="Shelf life (hours)"><Input name="shelf_life_hours" inputMode="numeric" defaultValue={s(recipe, "shelf_life_hours")} /></Field>
      <Field label="Produces inventory item" hint="For prep recipes counted as their own item (e.g. Salsa). Production then creates this item." className="sm:col-span-2">
        <Select name="product_id" defaultValue={s(recipe, "product_id")}><option value="">— Not inventoried —</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
      </Field>
      <label className="inline-flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="active" defaultChecked={recipe ? !!recipe.active : true} /> Active</label>
      <Field label="Preparation instructions" className="sm:col-span-2 lg:col-span-4"><Textarea name="instructions" defaultValue={s(recipe, "instructions")} rows={4} /></Field>
    </fieldset>
  );
}
