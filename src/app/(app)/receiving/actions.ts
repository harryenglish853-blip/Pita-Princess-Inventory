"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export type ReceiptTotals = {
  lines_total: number; calculated_total: number; invoice_total: number | null; over_short: number | null; received_value: number;
  tolerance: number; within_tolerance: boolean; exceptions: number; unreceived_lines: number;
};

export async function saveReceipt(id: string, header: Record<string, unknown> | null, lines: Record<string, unknown>[]): Promise<ActionState<ReceiptTotals>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_receipt", { p_receipt: id, p_header: header, p_lines: lines });
  if (error) return fail(error);
  return ok("Saved", data as ReceiptTotals);
}

export async function completeReceiving(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_receiving", { p_receipt: id });
  if (error) return fail(error);
  return ok("Delivery received");
}

export async function postReceipt(id: string, overrideReason?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("post_receipt", { p_receipt: id, p_override_reason: overrideReason || null });
  if (error) return fail(error);
  const r = data as { lines: number; inventory_value: number; price_alerts: number };
  return ok(`Invoice reconciled and posted: ${r.lines} lines, $${Number(r.inventory_value).toFixed(2)} into inventory${r.price_alerts ? `, ${r.price_alerts} price alert(s)` : ""}`);
}

export async function cancelReceipt(id: string, reason?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_receipt", { p_receipt: id, p_reason: reason ?? "" });
  if (error) return fail(error);
  return ok("Receipt cancelled");
}

export async function newReceipt(vendorId: string): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_receipt", { p_location: ctx.location.id, p_vendor: vendorId, p_po: null, p_client_key: null });
  if (error) return fail(error);
  return ok(undefined, { id: data as string });
}
