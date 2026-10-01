"use server";
import { createClient } from "@/lib/supabase/server";
import { canOrg, requireContext } from "@/lib/session";
import { fail, ok, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";
import { dispatchPendingEmails } from "@/lib/email/dispatch";

export async function saveRecipient(id: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const kinds = fd.getAll("kinds").map(String);
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_email_recipient", {
    p_org: ctx.organizationId, p_id: id, p_name: str(fd, "name"), p_email: str(fd, "email"),
    p_location: str(fd, "location_id") || null, p_active: id ? fd.get("active") === "on" : true, p_kinds: kinds,
  });
  if (error) return fail(error);
  return ok(id ? "Recipient updated" : "Recipient added");
}

export async function generateReport(kind: "daily_report" | "weekly_report" | "monthly_report"): Promise<ActionState<{ id: string }>> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("generate_report_now", { p_location: ctx.location.id, p_kind: kind, p_date: null });
  if (error) return fail(error);
  return ok("Report generated. Preview it below; it is sent with the next batch if email is set up.", { id: data as string });
}

export async function retryEmail(id: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("retry_email", { p_id: id });
  if (error) return fail(error);
  return ok("Queued again");
}

/** Owners can push pending emails out now instead of waiting for the 15-minute job. */
export async function sendPendingNow(): Promise<ActionState> {
  const ctx = await requireContext();
  if (!canOrg(ctx, "settings.manage")) return fail({ message: "Only owners can send emails from here." });
  try {
    const r = await dispatchPendingEmails(50);
    if (!r.configured) return fail({ message: `Email is not set up on this server (missing ${r.missing?.join(", ")}).` });
    return ok(`${r.sent} sent${r.failed ? `, ${r.failed} failed (see the list)` : ""}`);
  } catch (e) {
    return fail({ message: e instanceof Error ? e.message : String(e) });
  }
}
