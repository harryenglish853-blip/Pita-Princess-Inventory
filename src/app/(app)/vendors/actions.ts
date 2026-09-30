"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { bool, fail, ok, optNum, optStr, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

const fields = (fd: FormData) => ({
  name: str(fd, "name"), vendor_number: optStr(fd, "vendor_number"), account_number: optStr(fd, "account_number"),
  sales_rep: optStr(fd, "sales_rep"), phone: optStr(fd, "phone"), email: optStr(fd, "email"), ordering_email: optStr(fd, "ordering_email"),
  edi_enabled: bool(fd, "edi_enabled"), einvoice_enabled: bool(fd, "einvoice_enabled"), order_website: optStr(fd, "order_website"),
  delivery_days: fd.getAll("delivery_days").map((d) => Number(d)),
  lead_time_days: Number(str(fd, "lead_time_days") || 1), order_cutoff: optStr(fd, "order_cutoff"),
  minimum_order: optNum(fd, "minimum_order") ?? "0", freight_rules: optStr(fd, "freight_rules"),
  payment_terms: optStr(fd, "payment_terms"), notes: optStr(fd, "notes"), active: fd.has("active") ? bool(fd, "active") : true,
});

export async function saveVendor(id: string | null, _: ActionState, fd: FormData): Promise<ActionState<{ id: string }>> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const q = id
      ? supabase.from("vendors").update(fields(fd)).eq("id", id).select("id")
      : supabase.from("vendors").insert({ ...fields(fd), organization_id: ctx.organizationId }).select("id");
    const { data, error } = await q;
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to edit vendors." });
    return ok("Vendor saved", { id: data[0].id });
  } catch (e) { return fail(e as Error); }
}

export async function saveGuideItem(vendorId: string, id: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const row = {
      vendor_item_number: str(fd, "vendor_item_number"), purchase_unit_id: str(fd, "purchase_unit_id"), pack_size: optStr(fd, "pack_size"),
      current_price: optNum(fd, "current_price") ?? "0", contract_price: optNum(fd, "contract_price"),
      contract_start: optStr(fd, "contract_start"), contract_end: optStr(fd, "contract_end"),
      order_multiple: optNum(fd, "order_multiple") ?? "1", min_order_qty: optNum(fd, "min_order_qty") ?? "0",
      is_preferred: bool(fd, "is_preferred"), active: fd.has("active") ? bool(fd, "active") : true,
      guide_sort: Number(str(fd, "guide_sort") || 0),
    };
    const q = id
      ? supabase.from("vendor_products").update(row).eq("id", id).select("id")
      : supabase.from("vendor_products").insert({ ...row, organization_id: ctx.organizationId, vendor_id: vendorId, product_id: str(fd, "product_id") }).select("id");
    const { data, error } = await q;
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to edit order guides." });
    return ok("Order guide updated");
  } catch (e) { return fail(e as Error); }
}

/** Store-level overrides for a vendor. Blank fields fall back to the company setting. */
export async function saveStoreVendor(vendorId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const lead = optStr(fd, "lead_time_days");
    if (lead !== null && !/^\d+$/.test(lead)) return fail({ message: "Lead time must be a whole number of days." });
    const row = {
      organization_id: ctx.organizationId, location_id: ctx.location.id, vendor_id: vendorId,
      account_number: optStr(fd, "account_number"),
      lead_time_days: lead === null ? null : Number(lead),
      order_cutoff: optStr(fd, "order_cutoff"),
      delivery_days: bool(fd, "override_days") ? fd.getAll("delivery_days").map((d) => Number(d)) : null,
      active: bool(fd, "active"),
      notes: optStr(fd, "notes"),
    };
    const { data, error } = await supabase.from("location_vendors").upsert(row, { onConflict: "location_id,vendor_id" }).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to change this store's vendor settings." });
    return ok(`Saved for #${ctx.location.code}`);
  } catch (e) { return fail(e as Error); }
}

export async function resetStoreVendor(vendorId: string): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { error } = await supabase.from("location_vendors").delete().eq("location_id", ctx.location.id).eq("vendor_id", vendorId);
  if (error) return fail(error);
  return ok("Store now uses the company settings");
}
