"use server";
import { createClient } from "@/lib/supabase/server";
import { requireContext } from "@/lib/session";
import { fail, ok, optStr, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export async function ackAlert(id: string, resolve: boolean): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("acknowledge_alert", { p_alert: id, p_resolve: resolve });
  if (error) return fail(error);
  return ok(resolve ? "Alert resolved" : "Alert acknowledged");
}

export async function completeTask(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_task", { p_task: id });
  if (error) return fail(error);
  return ok("Task complete");
}

export async function createTask(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const due = str(fd, "due_at");
  const { error } = await supabase.from("tasks").insert({
    organization_id: ctx.organizationId, location_id: ctx.location.id, title: str(fd, "title"), description: optStr(fd, "description"),
    task_type: str(fd, "task_type") || "custom", due_at: due ? new Date(due).toISOString() : new Date().toISOString(),
    assigned_to: optStr(fd, "assigned_to"), recurrence: optStr(fd, "recurrence"), created_by: ctx.user.id,
  });
  if (error) return fail(error);
  return ok("Task created");
}
