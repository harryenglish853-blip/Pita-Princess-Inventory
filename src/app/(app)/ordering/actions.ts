"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

type Line = { product_id: string; vendor_product_id: string; unit_id: string; order_qty: string; suggested_qty: string; suggestion: unknown };

/**
 * Records an order the manager placed on the vendor's own website: a submitted
 * purchase order holding both the system suggestion and the manager's quantity.
 * It then counts as incoming stock, and the delivery is checked against it.
 */
export async function markOrdered(input: { vendorId: string; deliveryDate: string; nextDeliveryDate: string | null; lines: Line[]; clientKey: string; note?: string }):
  Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const lines = input.lines.filter((l) => Number(l.order_qty) > 0 || Number(l.suggested_qty) > 0);
  if (!lines.some((l) => Number(l.order_qty) > 0)) return fail({ message: "Enter at least one quantity" });
  if (lines.some((l) => !/^\d+(\.\d+)?$/.test(String(l.order_qty || "0")))) return fail({ message: "Quantities must be numbers" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_purchase_order", {
    p_location: ctx.location.id, p_vendor: input.vendorId, p_delivery_date: input.deliveryDate, p_lines: lines,
    p_next_delivery_date: input.nextDeliveryDate, p_notes: input.note?.trim() || "Ordered on the vendor's website",
    p_client_key: input.clientKey, p_delivery_window: null,
  });
  if (error) return fail(error);
  const id = data as string;
  // The order was already placed with the vendor, so the in-app minimum check is informational only.
  const { error: e2 } = await supabase.rpc("set_purchase_order_status", { p_po: id, p_status: "submitted", p_confirm_below_minimum: true });
  if (e2 && !/already submitted/i.test(e2.message)) return fail(e2);
  return ok("Marked as ordered. It now shows as an expected delivery.", { id });
}
