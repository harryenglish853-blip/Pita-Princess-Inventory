import { createHmac, timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { extractToastOrders, normalizeToastOrder } from "@/lib/pos/toast-orders";
import { dispatchPendingEmails } from "@/lib/email/dispatch";

export const dynamic = "force-dynamic";

/**
 * Toast order webhook. The body must be signed with TOAST_WEBHOOK_SECRET
 * (HMAC-SHA256, base64) in the header named by TOAST_SIGNATURE_HEADER
 * (default "Toast-Signature"); the restaurant is identified by the
 * "Toast-Restaurant-External-ID" header and mapped to a store on the Toast
 * screen. Processing is idempotent, so Toast retries are harmless.
 *
 * BLOCKED — REQUIRES EXTERNAL CONFIGURATION: Toast partner API access to register
 * the webhook. Signature and header names follow Toast's documentation but are
 * NOT YET VERIFIED against live Toast traffic.
 */
function verify(raw: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("base64"));
  const got = Buffer.from(signature.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

export async function POST(req: Request) {
  const secret = process.env.TOAST_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "Toast webhook is not configured" }, { status: 503 });
  const raw = await req.text();
  if (raw.length > 2_000_000) return Response.json({ error: "Payload too large" }, { status: 413 });
  if (!verify(raw, req.headers.get(process.env.TOAST_SIGNATURE_HEADER ?? "Toast-Signature"), secret)) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  const restaurant = req.headers.get("Toast-Restaurant-External-ID") ?? (body as { restaurantGuid?: string })?.restaurantGuid ?? null;
  if (!restaurant) return Response.json({ error: "Missing Toast-Restaurant-External-ID" }, { status: 400 });
  const admin = createAdminClient();
  const { data: locationId } = await admin.rpc("toast_location_for", { p_restaurant_guid: restaurant });
  // Unknown restaurant: acknowledge so Toast stops retrying, nothing is stored.
  if (!locationId) return Response.json({ ignored: true, reason: "Restaurant not connected to a store" }, { status: 202 });
  const results = [];
  for (const raw of extractToastOrders(body)) {
    try {
      const order = normalizeToastOrder(raw);
      const { data, error } = await admin.rpc("ingest_toast_order", { p_location: locationId, p_order: order, p_source: "webhook" });
      results.push(error ? { guid: order.guid, status: "error", message: error.message } : data);
    } catch (e) {
      results.push({ guid: (raw as { guid?: string })?.guid ?? null, status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  after(() => dispatchPendingEmails().catch(() => undefined)); // sync failures email the owners
  // 5xx makes Toast retry; only a database outage warrants that.
  const failed = results.filter((r) => (r as { status?: string })?.status === "error" && /fetch failed|ECONN/i.test((r as { message?: string }).message ?? ""));
  return Response.json({ processed: results.length, results }, { status: failed.length ? 503 : 200 });
}
