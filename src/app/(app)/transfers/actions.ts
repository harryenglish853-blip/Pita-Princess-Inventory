"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

type Line = { product_id: string; unit_id: string; qty: string };

export async function createTransfer(input: { type: "storage" | "location"; from: string | null; to: string; lines: Line[]; notes: string; clientKey: string }): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data, error } = input.type === "storage"
    ? await supabase.rpc("transfer_between_storage", { p_location: ctx.location.id, p_from: input.from, p_to: input.to, p_lines: input.lines, p_notes: input.notes || null, p_client_key: input.clientKey })
    : await supabase.rpc("create_location_transfer", { p_from: ctx.location.id, p_to: input.to, p_lines: input.lines, p_notes: input.notes || null, p_client_key: input.clientKey });
  if (error) return fail(error);
  return ok(input.type === "storage" ? "Moved between storage areas" : "Transfer created — review and send it", { id: data as string });
}

export async function sendTransfer(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("send_transfer", { p_transfer: id });
  if (error) return fail(error);
  return ok("Transfer sent — inventory is now in transit");
}

export async function cancelTransfer(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_transfer", { p_transfer: id });
  if (error) return fail(error);
  return ok("Transfer cancelled");
}

export async function receiveTransfer(id: string, lines: { id: string; qty_received: string }[]): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receive_transfer", { p_transfer: id, p_lines: lines, p_reconcile: true });
  if (error) return fail(error);
  const r = data as { shortage_value: number };
  return ok(`Transfer received and reconciled${Number(r.shortage_value) > 0 ? ` (short $${Number(r.shortage_value).toFixed(2)})` : ""}`);
}
