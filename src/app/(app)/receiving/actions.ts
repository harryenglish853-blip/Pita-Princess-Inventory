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

// ---------------------------------------------------------------- invoice scanning (AI-assisted, human-confirmed)
import { extractInvoice, invoiceScannerConfigured, type ExtractedInvoice } from "@/lib/ai/invoice-extract";

export async function scanInvoice(receiptId: string, fd: FormData): Promise<ActionState<{ invoice: ExtractedInvoice; scanId: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data: r } = await supabase.from("receipts").select("id, location_id, organization_id, status").eq("id", receiptId).single();
  if (!r) return fail({ message: "Receipt not found" });
  if (!ctx.locations.find((l) => l.id === r.location_id)?.permissions.includes("orders.receive")) return fail({ message: "You do not have permission to receive deliveries." });
  if (!invoiceScannerConfigured()) return fail({ message: "Invoice scanning is not set up on this server (ANTHROPIC_API_KEY is missing). Enter the invoice manually." });
  const file = fd.get("file");
  if (!(file instanceof File) || file.size === 0) return fail({ message: "Choose a photo or PDF of the invoice" });
  if (file.size > 20 * 1024 * 1024) return fail({ message: "The file is larger than 20 MB" });
  const mediaType = file.type || "image/jpeg";
  if (!["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"].includes(mediaType)) return fail({ message: "Use a JPEG, PNG, WebP or PDF file" });
  try {
    const { invoice, model } = await extractInvoice({ base64: Buffer.from(await file.arrayBuffer()).toString("base64"), mediaType });
    const { data: scan, error } = await supabase.from("invoice_scans").insert({
      organization_id: r.organization_id, location_id: r.location_id, receipt_id: receiptId, file_name: file.name, media_type: mediaType, extracted: invoice, model,
    }).select("id").single();
    if (error) return fail(error);
    return ok("Invoice read. Check every value before applying.", { invoice, scanId: scan.id });
  } catch (e) {
    return fail({ message: (e as Error).message || "The invoice could not be read" });
  }
}
