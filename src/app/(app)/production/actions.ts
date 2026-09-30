"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok, optNum, optStr, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export async function recordProduction(_: ActionState, fd: FormData): Promise<ActionState> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("record_production", {
      p_location: ctx.location.id, p_recipe: str(fd, "recipe_id"), p_expected_qty: optNum(fd, "expected_qty"), p_actual_qty: optNum(fd, "actual_qty"),
      p_storage: optStr(fd, "storage_id"), p_notes: optStr(fd, "notes"), p_at: null, p_client_key: str(fd, "client_key") || null,
    });
    if (error) return fail(error);
    const r = data as { ingredient_cost: number; yield_variance: number; duplicate?: boolean };
    if (r.duplicate) return ok("Already recorded");
    return ok(`Production recorded. Ingredient cost $${Number(r.ingredient_cost).toFixed(2)}, yield variance ${r.yield_variance > 0 ? "+" : ""}${r.yield_variance}`);
  } catch (e) { return fail(e as Error); }
}
