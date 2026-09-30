"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok, optStr, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export async function createCount(_: ActionState, fd: FormData): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const storages = fd.getAll("storage_ids").map(String).filter(Boolean);
  const cats = fd.getAll("category_ids").map(String).filter(Boolean);
  const at = str(fd, "count_at");
  const { data, error } = await supabase.rpc("create_count_session", {
    p_location: ctx.location.id,
    p_count_type: str(fd, "count_type"),
    p_name: optStr(fd, "name"),
    p_count_at: at ? new Date(at).toISOString() : null,
    p_storage_ids: storages.length ? storages : null,
    p_category_ids: cats.length ? cats : null,
    p_client_key: str(fd, "client_key") || null,
    p_notes: optStr(fd, "notes"),
  });
  if (error) return fail(error);
  return ok("Count created", { id: data as string });
}

const rpc = async (fn: string, args: Record<string, unknown>, message: string): Promise<ActionState> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return fail(error);
  return ok(message, data);
};

export const submitCount = async (id: string) => rpc("submit_count_session", { p_session: id }, "Count submitted for review");
export const reopenCount = async (id: string) => rpc("reopen_count_session", { p_session: id }, "Count reopened");
export const markReviewed = async (id: string) => rpc("mark_count_reviewed", { p_session: id }, "Marked as reviewed");
export const cancelCount = async (id: string, reason?: string) => rpc("cancel_count_session", { p_session: id, p_reason: reason ?? "" }, "Count cancelled");
export const requestRecount = async (id: string, productIds: string[]) => rpc("request_recount", { p_session: id, p_product_ids: productIds }, "Recount requested");
export const resolveConflict = async (entryId: string, revisionId: number) => rpc("resolve_count_conflict", { p_entry: entryId, p_revision_id: revisionId }, "Conflict resolved");

export async function postCount(id: string, acknowledge: boolean): Promise<ActionState> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("post_count_session", { p_session: id, p_acknowledge_flags: acknowledge });
  if (error) return fail(error);
  const r = data as { lines: number; variance_value: number };
  await supabase.rpc("refresh_stock_alerts", { p_location: (await requireContext()).location.id });
  return ok(`Inventory posted: ${r.lines} items, variance ${r.variance_value < 0 ? "-" : ""}$${Math.abs(r.variance_value).toFixed(2)}`);
}
