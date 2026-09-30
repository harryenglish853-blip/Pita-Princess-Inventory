"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok, optNum, optStr, str, bool } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

const fields = (fd: FormData) => ({
  name: str(fd, "name"), recipe_type: str(fd, "recipe_type") || "menu_item", yield_qty: optNum(fd, "yield_qty") ?? "1",
  yield_unit_id: str(fd, "yield_unit_id"), product_id: optStr(fd, "product_id"), serving_size: optStr(fd, "serving_size"),
  instructions: optStr(fd, "instructions"), prep_loss_pct: optNum(fd, "prep_loss_pct") ?? "0",
  shelf_life_hours: optNum(fd, "shelf_life_hours"), active: fd.has("active") ? bool(fd, "active") : true,
});

export async function saveRecipe(id: string | null, _: ActionState, fd: FormData): Promise<ActionState<{ id: string }>> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const { data, error } = id
      ? await supabase.from("recipes").update(fields(fd)).eq("id", id).select("id")
      : await supabase.from("recipes").insert({ ...fields(fd), organization_id: ctx.organizationId, created_by: ctx.user.id }).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "Recipes are corporate master data. You do not have permission to edit them." });
    return ok("Recipe saved", { id: data[0].id });
  } catch (e) { return fail(e as Error); }
}

export async function addIngredient(recipeId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const [kind, refId] = str(fd, "item").split(":");
    const { error } = await supabase.from("recipe_ingredients").insert({
      organization_id: ctx.organizationId, recipe_id: recipeId,
      product_id: kind === "p" ? refId : null, sub_recipe_id: kind === "r" ? refId : null,
      quantity: optNum(fd, "quantity"), unit_id: str(fd, "unit_id"), yield_pct: optNum(fd, "yield_pct") ?? "100",
      sort: Number(str(fd, "sort") || 0),
    });
    if (error) return fail(error);
    return ok("Ingredient added");
  } catch (e) { return fail(e as Error); }
}

export async function removeIngredient(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("recipe_ingredients").delete().eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to edit recipes." });
  return ok("Ingredient removed");
}

export async function updateIngredient(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("recipe_ingredients").update({ quantity: optNum(fd, "quantity"), unit_id: str(fd, "unit_id"), yield_pct: optNum(fd, "yield_pct") ?? "100" }).eq("id", id).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to edit recipes." });
    return ok("Ingredient updated");
  } catch (e) { return fail(e as Error); }
}

export async function saveMenuItem(id: string | null, recipeId: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const row = { name: str(fd, "name"), pos_item_id: optStr(fd, "pos_item_id"), menu_category: optStr(fd, "menu_category"),
                  selling_price: optNum(fd, "selling_price"), portion_qty: optNum(fd, "portion_qty") ?? "1",
                  recipe_id: recipeId ?? optStr(fd, "recipe_id"), active: fd.has("active") ? bool(fd, "active") : true };
    const { data, error } = id
      ? await supabase.from("menu_items").update(row).eq("id", id).select("id")
      : await supabase.from("menu_items").insert({ ...row, organization_id: ctx.organizationId }).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to edit menu items." });
    return ok("Menu item saved");
  } catch (e) { return fail(e as Error); }
}
