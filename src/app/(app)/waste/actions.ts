"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export async function logWaste(input: {
  kind: "product" | "recipe"; id: string; qty: string; unitId: string; reason: string; storageId: string | null;
  comment: string | null; photo: string | null; clientKey: string; at: string | null;
}): Promise<ActionState<{ cost: number }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  if (input.photo && input.photo.length > 400_000) return fail({ message: "Photo is too large" });
  const { data, error } = await supabase.rpc("log_waste", {
    p_location: ctx.location.id,
    p_product: input.kind === "product" ? input.id : null,
    p_recipe: input.kind === "recipe" ? input.id : null,
    p_qty: input.qty, p_unit: input.unitId, p_reason: input.reason, p_storage: input.storageId,
    p_comment: input.comment, p_photo: input.photo, p_at: input.at, p_client_key: input.clientKey,
  });
  if (error) return fail(error);
  const r = data as { cost: number; duplicate?: boolean };
  return ok(r.duplicate ? "Already logged" : `Waste logged ($${Number(r.cost ?? 0).toFixed(2)})`, { cost: Number(r.cost ?? 0) });
}
