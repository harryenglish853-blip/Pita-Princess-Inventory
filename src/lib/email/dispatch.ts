import "server-only";
import { createAdminClient } from "@/lib/supabase/server";
import { renderEmail, type OutboxRow } from "./templates";

/** Public address of the app, used for links in emails. */
export function appUrl(): string {
  const u = process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  return (u ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function emailConfigured(): { ok: boolean; missing: string[] } {
  const missing = ["RESEND_API_KEY", "EMAIL_FROM", "SUPABASE_SERVICE_ROLE_KEY"].filter((k) => !process.env[k]);
  return { ok: missing.length === 0, missing };
}

type SendResult = { ok: true; id: string } | { ok: false; error: string; retry: boolean };

/** Sends one email through Resend. The outbox id is the idempotency key, so a retried request never sends twice. */
async function sendWithResend(row: OutboxRow & { recipients: string[] }): Promise<SendResult> {
  const r = renderEmail(row, appUrl());
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": row.id },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: row.recipients, subject: r.subject, html: r.html, text: r.text }),
      signal: AbortSignal.timeout(15000),
    });
    const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
    if (res.ok && body.id) return { ok: true, id: body.id };
    // 4xx (bad address, unverified domain) will not fix itself; 429/5xx are retried
    return { ok: false, error: `${res.status} ${body.name ?? ""} ${body.message ?? ""}`.trim(), retry: res.status === 429 || res.status >= 500 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), retry: true };
  }
}

/** Sends pending outbox emails. Safe to call concurrently: rows are claimed with SKIP LOCKED. */
export async function dispatchPendingEmails(limit = 25): Promise<{ configured: boolean; sent: number; failed: number; missing?: string[] }> {
  const cfg = emailConfigured();
  if (!cfg.ok) return { configured: false, sent: 0, failed: 0, missing: cfg.missing };
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("claim_email_batch", { p_limit: limit });
  if (error) throw new Error(`claim_email_batch: ${error.message}`);
  let sent = 0, failed = 0;
  for (const row of (data ?? []) as (OutboxRow & { recipients: string[] })[]) {
    const res = await sendWithResend(row);
    if (res.ok) sent++; else failed++;
    // A permanent rejection is marked failed at once (owners can fix the address and retry); others retry up to 5 times.
    await admin.rpc("complete_email", {
      p_id: row.id, p_ok: res.ok, p_error: res.ok ? null : res.error, p_provider_id: res.ok ? res.id : null, p_permanent: !res.ok && !res.retry,
    });
  }
  return { configured: true, sent, failed };
}
