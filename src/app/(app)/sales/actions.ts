"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";
import type { NormalizedSales } from "@/lib/pos/adapters";

export async function importSales(input: { businessDate: string; source: string; fileName: string; data: NormalizedSales }): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  if (!input.data.lines.length) return fail({ message: "No sales lines to import" });
  const { data, error } = await supabase.rpc("import_sales", {
    p_location: ctx.location.id, p_business_date: input.businessDate, p_source: input.source, p_file_name: input.fileName,
    p_summary: input.data.summary, p_lines: input.data.lines,
  });
  if (error) return fail(error);
  const r = data as { id: string; unmapped: number; theoretical_cost: number };
  await supabase.rpc("refresh_stock_alerts", { p_location: ctx.location.id });
  return ok(`Imported. Theoretical cost $${Number(r.theoretical_cost).toFixed(2)}${r.unmapped ? ` · ${r.unmapped} unmapped item(s) need a recipe` : ""}`, { id: r.id });
}

export async function reverseImport(id: string, reason?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("reverse_sales_import", { p_import: id, p_reason: reason ?? "" });
  if (error) return fail(error);
  return ok("Import reversed; theoretical depletion was backed out");
}

export async function mapPosItem(posItemId: string | null, itemName: string, recipeId: string, price?: string): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc("map_pos_item", { p_org: ctx.organizationId, p_pos_item_id: posItemId, p_item_name: itemName, p_recipe: recipeId, p_price: price ? Number(price) : null });
  if (error) return fail(error);
  return ok(`${itemName} mapped. Future imports deplete its recipe.`);
}
