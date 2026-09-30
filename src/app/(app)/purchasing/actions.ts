"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export type OrderLine = { product_id: string; vendor_product_id: string | null; unit_id: string; order_qty: string; suggested_qty: string | null; suggestion: unknown };

export async function saveOrder(input: {
  poId: string | null; vendorId: string; deliveryDate: string; nextDeliveryDate: string | null; notes: string | null;
  deliveryWindow: string | null; lines: OrderLine[]; clientKey: string; submit: boolean; confirmBelowMinimum?: boolean;
}): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  let id = input.poId;
  const lines = input.lines.filter((l) => Number(l.order_qty) > 0 || l.suggested_qty !== null);
  if (id) {
    const { error } = await supabase.rpc("update_purchase_order", {
      p_po: id, p_lines: lines, p_delivery_date: input.deliveryDate, p_next_delivery_date: input.nextDeliveryDate,
      p_notes: input.notes, p_delivery_window: input.deliveryWindow,
    });
    if (error) return fail(error);
  } else {
    const { data, error } = await supabase.rpc("create_purchase_order", {
      p_location: ctx.location.id, p_vendor: input.vendorId, p_delivery_date: input.deliveryDate, p_lines: lines,
      p_next_delivery_date: input.nextDeliveryDate, p_notes: input.notes, p_client_key: input.clientKey, p_delivery_window: input.deliveryWindow,
    });
    if (error) return fail(error);
    id = data as string;
  }
  if (input.submit) {
    const { error } = await supabase.rpc("set_purchase_order_status", { p_po: id, p_status: "submitted", p_confirm_below_minimum: !!input.confirmBelowMinimum });
    if (error) return { ok: false, error: fail(error)!.error, at: Date.now(), data: { id: id! } };
    return ok("Order submitted", { id: id! });
  }
  return ok("Order saved as draft", { id: id! });
}

export async function setPoStatus(id: string, status: string, input?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_purchase_order_status", {
    p_po: id, p_status: status,
    p_reason: status === "cancelled" ? input ?? null : null,
    p_confirmation: status === "confirmed" ? input ?? null : null,
    p_confirm_below_minimum: status === "submitted",
  });
  if (error) return fail(error);
  return ok({ submitted: "Order submitted", confirmed: "Order confirmed", cancelled: "Order cancelled", ready_to_submit: "Marked ready to submit", draft: "Moved back to draft" }[status] ?? "Updated");
}

export async function startReceipt(poId: string | null, vendorId?: string): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_receipt", { p_location: ctx.location.id, p_vendor: vendorId ?? null, p_po: poId, p_client_key: null });
  if (error) return fail(error);
  return ok(undefined, { id: data as string });
}
