"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export async function saveStorageArea(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const id = str(fd, "id");
  const row = { name: str(fd, "name"), kind: str(fd, "kind") || "other", active: fd.get("active") !== "false" };
  const { data, error } = id
    ? await supabase.from("storage_locations").update(row).eq("id", id).select("id")
    : await supabase.from("storage_locations").insert({
        ...row, organization_id: ctx.organizationId, location_id: ctx.location.id,
        sort_order: Number(str(fd, "sort_order") || 99),
      }).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to manage storage areas." });
  return ok(id ? "Storage area saved" : "Storage area created");
}

export async function setStorageActive(id: string, active: boolean): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("storage_locations").update({ active }).eq("id", id).select("id");
  if (error) return fail(error);
  if (!data?.length) return fail({ message: "You do not have permission to manage storage areas." });
  return ok(active ? "Storage area reactivated" : "Storage area deactivated");
}

export async function saveSequence(storageId: string, items: { product_id: string; shelf: string | null }[]): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_storage_sequence", { p_storage_location: storageId, p_items: items });
  if (error) return fail(error);
  return ok("Shelf-to-sheet order saved");
}

export async function saveAreaOrder(ids: string[]): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_storage_area_order", { p_location: ctx.location.id, p_ids: ids });
  if (error) return fail(error);
  return ok("Walking order saved");
}
