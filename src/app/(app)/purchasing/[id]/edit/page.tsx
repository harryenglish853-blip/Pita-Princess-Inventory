import { notFound, redirect } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { OrderBuilder } from "../../order-builder";
import { loadSuggestions } from "../../load-suggestions";

export const metadata = { title: "Edit order" };

export default async function EditOrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ delivery?: string; next?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePermission("orders.create");
  const supabase = await createClient();
  const { data: po } = await supabase.from("purchase_orders").select("*, vendor:vendors(id, name, minimum_order, order_cutoff, lead_time_days)").eq("id", id).single();
  if (!po) notFound();
  // This store's cutoff and lead time (store overrides over company settings)
  const { data: store } = await supabase.from("location_vendor_settings").select("order_cutoff, lead_time_days").eq("vendor_id", po.vendor_id).eq("location_id", po.location_id).single();
  if (store) Object.assign(po.vendor as object, store);
  if (!["draft", "ready_to_submit"].includes(po.status)) redirect(`/purchasing/${id}`);
  const { data: items } = await supabase.from("purchase_order_items").select("vendor_product_id, order_qty").eq("po_id", id);
  const delivery = sp.delivery ?? po.expected_delivery_date;
  const next = sp.next ?? po.next_delivery_date;
  const { rows, error } = await loadSuggestions(ctx.location.id, po.vendor_id, delivery, next, id);
  const initialQty: Record<string, string> = {};
  for (const r of rows) initialQty[r.vendor_product_id] = "";
  for (const i of items ?? []) if (i.vendor_product_id) initialQty[i.vendor_product_id] = Number(i.order_qty) ? String(Number(i.order_qty)) : "";
  return (
    <>
      <PageHeader title={`Edit ${po.po_number}`} back={{ href: `/purchasing/${id}`, label: po.po_number }} />
      <OrderBuilder key={`${delivery}-${next}`} poId={id} vendor={po.vendor as never} deliveryDate={delivery} nextDeliveryDate={next} rows={rows} error={error}
        initialQty={sp.delivery ? undefined : initialQty} initialNotes={po.notes} showCost={can(ctx, "reports.view_cost")} canSubmit={can(ctx, "orders.submit")} />
    </>
  );
}
