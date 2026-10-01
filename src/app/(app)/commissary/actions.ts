"use server";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";
import { dispatchPendingEmails } from "@/lib/email/dispatch";

type Line = { product_id: string; unit_id: string; qty: string; notes?: string | null };

export async function saveCommissaryOrder(input: { id: string | null; vendorId: string; neededDate: string; notes: string; lines: Line[]; clientKey: string; submit: boolean }):
  Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.neededDate)) return fail({ message: "Choose the date you need it" });
  const lines = input.lines.filter((l) => Number(l.qty) > 0);
  if (lines.some((l) => !/^\d+(\.\d{1,4})?$/.test(l.qty))) return fail({ message: "Quantities must be numbers" });
  if (input.submit && !lines.length) return fail({ message: "Add at least one item" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_commissary_order", {
    p_id: input.id, p_location: ctx.location.id, p_vendor: input.vendorId, p_needed: input.neededDate, p_notes: input.notes,
    p_lines: lines, p_client_key: input.id ? null : input.clientKey,
  });
  if (error) return fail(error);
  const id = data as string;
  if (input.submit) {
    const { error: e2 } = await supabase.rpc("submit_commissary_order", { p_order: id });
    if (e2) return { ok: false, error: fail(e2)!.error, data: { id }, at: Date.now() };
    after(() => dispatchPendingEmails().catch(() => undefined)); // the commissary email goes out right away
    return ok("Commissary order submitted. The commissary has been emailed.", { id });
  }
  return ok("Draft saved", { id });
}

export async function submitCommissaryOrder(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("submit_commissary_order", { p_order: id });
  if (error) return fail(error);
  after(() => dispatchPendingEmails().catch(() => undefined));
  return ok("Submitted. The commissary has been emailed.");
}

export async function setCommissaryStatus(id: string, status: "accepted" | "preparing" | "ready" | "cancelled", reason?: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_commissary_status", { p_order: id, p_status: status, p_reason: reason ?? null });
  if (error) return fail(error);
  return ok({ accepted: "Accepted", preparing: "Marked as preparing", ready: "Marked ready", cancelled: "Order cancelled" }[status]);
}

export async function shipCommissaryOrder(id: string, lines: { id: string; qty_shipped: string }[]): Promise<ActionState> {
  if (lines.some((l) => !/^\d+(\.\d{1,4})?$/.test(l.qty_shipped || "0"))) return fail({ message: "Quantities must be numbers" });
  const supabase = await createClient();
  const { error } = await supabase.rpc("ship_commissary_order", { p_order: id, p_lines: lines });
  if (error) return fail(error);
  return ok("Shipped. The restaurant will confirm what arrives.");
}

export async function receiveCommissaryOrder(id: string, lines: { id: string; qty_received: string }[]): Promise<ActionState<{ issues: number }>> {
  if (lines.some((l) => !/^\d+(\.\d{1,4})?$/.test(l.qty_received))) return fail({ message: "Enter the quantity that arrived for every item (0 if none)" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("receive_commissary_order", { p_order: id, p_lines: lines });
  if (error) return fail(error);
  const issues = ((data as { issues: unknown[] }).issues ?? []).length;
  if (issues) after(() => dispatchPendingEmails().catch(() => undefined));
  return ok(issues ? `Received with ${issues} difference${issues === 1 ? "" : "s"} — management has been alerted` : "Received. Inventory updated.", { issues });
}
