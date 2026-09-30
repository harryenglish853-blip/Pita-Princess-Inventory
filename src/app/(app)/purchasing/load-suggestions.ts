import "server-only";
import { createClient } from "@/lib/supabase/server";

export type SuggestionRow = {
  vendor_product_id: string; product_id: string; product_number: string; product_name: string; category_name: string | null;
  vendor_item_number: string; pack_size: string | null; purchase_unit_id: string; purchase_unit: string; unit_factor: number;
  inventory_unit: string; unit_price: number; on_hand: number; on_order: number; par: number | null; par_mode: string;
  forecast_usage: number; suggested_qty: number; is_primary_vendor: boolean; explanation: Record<string, unknown>;
};

export async function loadSuggestions(locationId: string, vendorId: string, delivery: string, next: string | null, excludePo: string | null) {
  const supabase = await createClient();
  // Dynamic pars are recalculated from the current forecast before suggesting.
  await supabase.rpc("refresh_dynamic_pars", { p_location: locationId });
  const { data, error } = await supabase.rpc("suggest_order", {
    p_location: locationId, p_vendor: vendorId, p_delivery_date: delivery, p_next_delivery_date: next, p_exclude_po: excludePo,
  });
  return { rows: (data ?? []) as SuggestionRow[], error: error?.message ?? null };
}

/** The vendor's next delivery date strictly after `fromDate` (YYYY-MM-DD). Pure date math in UTC. */
export function nextDeliveryAfter(vendorDays: number[], fromDate: string): string {
  const base = new Date(`${fromDate}T12:00:00Z`);
  for (let i = 1; i <= 14; i++) {
    const d = new Date(base.getTime() + i * 86400000);
    if (!vendorDays.length || vendorDays.includes(d.getUTCDay())) return d.toISOString().slice(0, 10);
  }
  return new Date(base.getTime() + 7 * 86400000).toISOString().slice(0, 10);
}
