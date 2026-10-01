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
  // Toast orders already received for this item now deplete its recipe (once).
  const { data: re } = await supabase.rpc("reprocess_toast_orders", { p_location: ctx.location.id, p_since: null });
  const n = (re as { orders?: number } | null)?.orders ?? 0;
  return ok(`${itemName} mapped. Future imports deplete its recipe${n ? `; ${n} Toast order(s) updated` : ""}.`);
}

// ---------------------------------------------------------------- Toast order sync
import { extractToastOrders, normalizeToastOrder } from "@/lib/pos/toast-orders";

/** Manual upload of Toast order JSON (Orders API export), processed exactly like the webhook. */
export async function uploadToastOrders(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return fail({ message: "Choose a Toast orders JSON file" });
  if (file.size > 5_000_000) return fail({ message: "File is larger than 5 MB" });
  let body: unknown;
  try { body = JSON.parse(await file.text()); } catch { return fail({ message: "That file is not valid JSON" }); }
  const orders = extractToastOrders(body);
  if (!orders.length) return fail({ message: "No Toast orders found in the file" });
  const supabase = await createClient();
  const tally: Record<string, number> = {};
  for (const raw of orders) {
    let status = "error";
    try {
      const { data, error } = await supabase.rpc("ingest_toast_order", { p_location: ctx.location.id, p_order: normalizeToastOrder(raw), p_source: "manual" });
      if (error) return fail(error);
      status = (data as { status: string }).status;
    } catch { status = "error"; }
    tally[status] = (tally[status] ?? 0) + 1;
  }
  return ok(Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(", "));
}

export async function setToastRestaurant(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const guid = String(fd.get("restaurant_guid") ?? "").trim();
  const { error } = await supabase.rpc("set_toast_restaurant", { p_location: ctx.location.id, p_restaurant_guid: guid || null });
  if (error) return fail(error);
  return ok("Toast restaurant saved");
}

export async function reprocessToast(): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reprocess_toast_orders", { p_location: ctx.location.id, p_since: null });
  if (error) return fail(error);
  const r = data as { orders: number; movements: number };
  return ok(`${r.orders} order(s) reprocessed, ${r.movements} ingredient movement(s)`);
}
