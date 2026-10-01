import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { dispatchPendingEmails } from "@/lib/email/dispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

/**
 * Scheduled job (Vercel Cron, every 15 minutes): queue due reports, digests and
 * reminders, then send pending emails. Protected by CRON_SECRET (Vercel sends it
 * as a bearer token). Both steps are idempotent.
 */
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: schedule, error } = await admin.rpc("run_email_schedule");
  if (error) return Response.json({ error: `run_email_schedule: ${error.message}` }, { status: 500 });
  try {
    const sent = await dispatchPendingEmails(50);
    return Response.json({ schedule, ...sent });
  } catch (e) {
    return Response.json({ schedule, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
