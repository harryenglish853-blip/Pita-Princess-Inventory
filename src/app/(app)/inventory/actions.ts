"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { bool, fail, ok, optNum, optStr, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

const productFields = (fd: FormData) => ({
  product_number: str(fd, "product_number"),
  name: str(fd, "name"),
  description: optStr(fd, "description"),
  category_id: optStr(fd, "category_id"),
  recipe_unit_id: optStr(fd, "recipe_unit_id"),
  purchase_unit_id: optStr(fd, "purchase_unit_id"),
  sku: optStr(fd, "sku"),
  brand: optStr(fd, "brand"),
  manufacturer_number: optStr(fd, "manufacturer_number"),
  default_vendor_id: optStr(fd, "default_vendor_id"),
  standard_cost: optNum(fd, "standard_cost"),
  shelf_life_days: optNum(fd, "shelf_life_days"),
  lot_tracked: bool(fd, "lot_tracked"),
  expiration_tracked: bool(fd, "expiration_tracked"),
  catch_weight: bool(fd, "catch_weight"),
  taxable: bool(fd, "taxable"),
  is_prepped: bool(fd, "is_prepped"),
  gl_account: optStr(fd, "gl_account"),
  receiving_temp_min: optNum(fd, "receiving_temp_min"),
  receiving_temp_max: optNum(fd, "receiving_temp_max"),
  image_url: optStr(fd, "image_url"),
  notes: optStr(fd, "notes"),
});

export async function createProduct(_: ActionState, fd: FormData): Promise<ActionState<{ id: string }>> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const payload = {
      ...productFields(fd),
      location_id: ctx.location.id,
      inventory_unit_id: str(fd, "inventory_unit_id"),
      purchase_factor: optNum(fd, "purchase_factor"),
      count_unit_id: optStr(fd, "count_unit_id"),
      count_factor: optNum(fd, "count_factor"),
      vendor_item_number: optStr(fd, "vendor_item_number"),
      vendor_price: optNum(fd, "vendor_price"),
      pack_size: optStr(fd, "pack_size"),
      storage_location_id: optStr(fd, "storage_location_id"),
      shelf: optStr(fd, "shelf"),
      par_qty: optNum(fd, "par_qty"),
      upc: optStr(fd, "upc"),
    };
    if (!payload.inventory_unit_id) return fail({ message: "Choose the inventory unit" });
    if (payload.purchase_unit_id && payload.purchase_unit_id !== payload.inventory_unit_id && !payload.purchase_factor) {
      return fail({ message: "Enter how many inventory units are in one purchase unit" });
    }
    const { data, error } = await supabase.rpc("create_product", { p: payload });
    if (error) return fail(error);
    return ok("Product created", { id: data as string });
  } catch (e) {
    return fail(e as Error);
  }
}

export async function updateProduct(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("products").update(productFields(fd)).eq("id", id).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to edit corporate product data." });
    return ok("Product saved");
  } catch (e) {
    return fail(e as Error);
  }
}

export async function setProductActive(id: string, active: boolean): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("products").update({ active }).eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to change this product." });
  return ok(active ? "Product reactivated" : "Product deactivated");
}

export async function addProductUnit(productId: string, organizationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.from("product_units").insert({
      organization_id: organizationId,
      product_id: productId,
      unit_id: str(fd, "unit_id"),
      factor: optNum(fd, "factor"),
      label: optStr(fd, "label"),
      use_for_count: bool(fd, "use_for_count"),
      use_for_purchase: bool(fd, "use_for_purchase"),
    });
    if (error) return fail(error);
    return ok("Conversion added");
  } catch (e) {
    return fail(e as Error);
  }
}

export async function updateProductUnit(id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("product_units").update({
      factor: optNum(fd, "factor"), label: optStr(fd, "label"),
      use_for_count: bool(fd, "use_for_count"), use_for_purchase: bool(fd, "use_for_purchase"),
    }).eq("id", id).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to change conversions." });
    return ok("Conversion updated");
  } catch (e) {
    return fail(e as Error);
  }
}

export async function removeProductUnit(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data: pu } = await supabase.from("product_units").select("product_id, unit_id").eq("id", id).single();
  if (pu) {
    const { count } = await supabase.from("vendor_products").select("id", { count: "exact", head: true })
      .eq("product_id", pu.product_id).eq("purchase_unit_id", pu.unit_id).eq("active", true);
    if (count) return fail({ message: "A vendor order guide item is purchased in this unit. Change it first." });
  }
  const { data, error } = await supabase.from("product_units").delete().eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to change conversions." });
  return ok("Conversion removed");
}

export async function updateLocalSettings(locationProductId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("location_products").update({
      par_mode: str(fd, "par_mode") || "static",
      par_qty: optNum(fd, "par_qty"),
      min_qty: optNum(fd, "min_qty"),
      reorder_point: optNum(fd, "reorder_point"),
      safety_stock_qty: optNum(fd, "safety_stock_qty"),
      safety_stock_days: optNum(fd, "safety_stock_days"),
      local_vendor_id: optStr(fd, "local_vendor_id"),
      count_daily: bool(fd, "count_daily"),
      count_weekly: bool(fd, "count_weekly"),
      active: bool(fd, "active"),
    }).eq("id", locationProductId).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to change local settings." });
    return ok("Local settings saved");
  } catch (e) {
    return fail(e as Error);
  }
}

export async function adjustInventory(productId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const direction = str(fd, "direction") === "add" ? 1 : -1;
    const amount = Number(str(fd, "qty"));
    if (!Number.isFinite(amount) || amount <= 0) return fail({ message: "Enter a quantity greater than 0" });
    const { data, error } = await supabase.rpc("adjust_inventory", {
      p_location: ctx.location.id,
      p_product: productId,
      p_qty: String(direction * amount),
      p_unit: str(fd, "unit_id"),
      p_reason_code: str(fd, "reason_code"),
      p_comment: optStr(fd, "comment"),
      p_storage: optStr(fd, "storage_location_id"),
      p_idempotency_key: str(fd, "idempotency_key") || null,
    });
    if (error) return fail(error);
    const r = data as { original_qty: number; new_qty: number; duplicate?: boolean };
    if (r.duplicate) return ok("This adjustment was already recorded");
    return ok(`Adjusted: ${r.original_qty} → ${r.new_qty}`);
  } catch (e) {
    return fail(e as Error);
  }
}

export async function addBarcode(productId: string, organizationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.from("product_barcodes").insert({
    organization_id: organizationId, product_id: productId, barcode: str(fd, "barcode"),
    unit_id: optStr(fd, "unit_id"), vendor_id: optStr(fd, "vendor_id"),
  });
  if (error) return fail(error);
  return ok("Barcode mapped");
}

export async function removeBarcode(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("product_barcodes").delete().eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to remove barcodes." });
  return ok("Barcode removed");
}

export async function upsertVendorItem(productId: string, organizationId: string, vendorProductId: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const supabase = await createClient();
    const row = {
      vendor_item_number: str(fd, "vendor_item_number"),
      description: optStr(fd, "description"),
      purchase_unit_id: str(fd, "purchase_unit_id"),
      pack_size: optStr(fd, "pack_size"),
      current_price: optNum(fd, "current_price") ?? "0",
      contract_price: optNum(fd, "contract_price"),
      contract_start: optStr(fd, "contract_start"),
      contract_end: optStr(fd, "contract_end"),
      order_multiple: optNum(fd, "order_multiple") ?? "1",
      min_order_qty: optNum(fd, "min_order_qty") ?? "0",
      is_preferred: bool(fd, "is_preferred"),
      active: fd.has("active") ? bool(fd, "active") : true,
    };
    const q = vendorProductId
      ? supabase.from("vendor_products").update(row).eq("id", vendorProductId).select("id")
      : supabase.from("vendor_products").insert({ ...row, organization_id: organizationId, product_id: productId, vendor_id: str(fd, "vendor_id") }).select("id");
    const { data, error } = await q;
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to edit vendor order guides." });
    return ok("Vendor item saved");
  } catch (e) {
    return fail(e as Error);
  }
}

// ---------------------------------------------------------------- categories & units
export async function saveCategory(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const id = optStr(fd, "id");
  const row = { name: str(fd, "name"), parent_id: optStr(fd, "parent_id"), gl_account: optStr(fd, "gl_account"),
                cost_group: str(fd, "cost_group") || "food", is_food: str(fd, "cost_group") === "food" };
  const { data, error } = id
    ? await supabase.from("categories").update(row).eq("id", id).select("id")
    : await supabase.from("categories").insert({ ...row, organization_id: ctx.organizationId }).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to edit categories." });
  return ok("Category saved");
}

export async function saveUnit(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const dimension = str(fd, "dimension");
  const { error } = await supabase.from("units").insert({
    organization_id: ctx.organizationId, code: str(fd, "code").toUpperCase(), name: str(fd, "name"), dimension,
    std_factor: dimension === "package" ? null : optNum(fd, "std_factor"),
  });
  if (error) return fail(error);
  return ok("Unit added");
}

export type ImportReport = {
  applied: boolean;
  summary: { create: number; update: number; skip: number; categories: string[]; vendors: string[]; storage_areas: string[] };
  rows: { row: number; name: string; item_number?: string; action: "create" | "update" | "skip"; errors: string[]; warnings: string[] }[];
};

/** Preview (apply = false, nothing saved) or import a product spreadsheet. One database call either way. */
export async function importProducts(rows: Record<string, string>[], apply: boolean): Promise<ActionState<ImportReport>> {
  const ctx = await requireContext();
  if (!rows.length) return fail({ message: "The sheet has no item rows under the header row." });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("import_products", { p_location: ctx.location.id, p_rows: rows, p_apply: apply });
  if (error) return fail(error);
  const r = data as ImportReport;
  return ok(apply ? `Imported: ${r.summary.create} new, ${r.summary.update} updated${r.summary.skip ? `, ${r.summary.skip} skipped` : ""}` : "Preview ready", r);
}
