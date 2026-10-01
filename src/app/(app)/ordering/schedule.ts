import "server-only";
import { createClient } from "@/lib/supabase/server";

export type VendorSchedule = {
  vendor_id: string; vendor_name: string; kind: "distributor" | "commissary" | "other"; order_website: string | null; account_number: string | null;
  minimum_order: number; delivery_days: number[] | null; order_cutoff: string | null; lead_time_days: number;
  delivery_date: string | null; order_by: string | null; next_delivery_date: string | null;
  ordered_po_id: string | null; ordered_po_number: string | null; ordered_at: string | null;
};

export async function loadSchedule(locationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("vendor_order_schedule", { p_location: locationId });
  return { vendors: (data ?? []) as VendorSchedule[], error: error?.message ?? null };
}

/** Only http(s) links are rendered (the database also enforces this). */
export function safeWebsite(url: string | null | undefined): string | null {
  return url && /^https?:\/\/\S+$/i.test(url) ? url : null;
}

export function deliveryLabel(date: string | null): string {
  if (!date) return "—";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export function deadlineLabel(orderBy: string | null, tz: string): string {
  if (!orderBy) return "—";
  return new Date(orderBy).toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit", timeZone: tz });
}

/** "in 3 h 20 min" / "in 2 days" until the cutoff. */
export function timeLeft(orderBy: string | null, now = Date.now()): string | null {
  if (!orderBy) return null;
  const mins = Math.round((new Date(orderBy).getTime() - now) / 60000);
  if (mins <= 0) return "cutoff passed";
  if (mins < 60) return `${mins} min left`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)} h ${mins % 60} min left`;
  return `${Math.round(mins / 1440)} days left`;
}
