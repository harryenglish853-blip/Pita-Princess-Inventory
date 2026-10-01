import { notFound } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Notice, PageHeader } from "@/components/ui";
import type { SuggestionRow } from "../../purchasing/load-suggestions";
import { deadlineLabel, deliveryLabel, loadSchedule, safeWebsite, timeLeft } from "../schedule";
import { VendorOrder } from "./vendor-order";

export const metadata = { title: "Suggested order" };

export default async function VendorOrderPage({ params }: { params: Promise<{ vendorId: string }> }) {
  const { vendorId } = await params;
  const ctx = await requirePermission("orders.view");
  const { vendors } = await loadSchedule(ctx.location.id);
  const v = vendors.find((x) => x.vendor_id === vendorId);
  if (!v || v.kind === "commissary") notFound();
  const supabase = await createClient();
  await supabase.rpc("refresh_dynamic_pars", { p_location: ctx.location.id });
  const { data, error } = v.delivery_date ? await supabase.rpc("suggest_order", {
    p_location: ctx.location.id, p_vendor: v.vendor_id, p_delivery_date: v.delivery_date, p_next_delivery_date: v.next_delivery_date, p_exclude_po: null,
  }) : { data: [], error: { message: "This vendor has no delivery days set." } };
  return (
    <>
      <PageHeader title={`${v.vendor_name} — suggested order`} back={{ href: "/ordering", label: "Ordering center" }}
        subtitle={`Delivery ${deliveryLabel(v.delivery_date)} · order by ${deadlineLabel(v.order_by, ctx.location.timezone)}${timeLeft(v.order_by) ? ` (${timeLeft(v.order_by)})` : ""}`} />
      {error ? <Notice tone="danger">{error.message}</Notice> : null}
      {v.ordered_po_id ? <div className="mb-3"><Notice tone="success" title={`Already marked as ordered (${v.ordered_po_number})`}>
        Its quantities count as incoming, so the suggestions below are what is still needed on top of it.</Notice></div> : null}
      <VendorOrder
        vendor={{ id: v.vendor_id, name: v.vendor_name, website: safeWebsite(v.order_website), account: v.account_number, minimum: Number(v.minimum_order) }}
        store={`#${ctx.location.code} ${ctx.location.name}`} deliveryDate={v.delivery_date} nextDeliveryDate={v.next_delivery_date}
        rows={(data ?? []) as SuggestionRow[]} showCost={can(ctx, "reports.view_cost")} canOrder={can(ctx, "orders.create") && can(ctx, "orders.submit")} />
    </>
  );
}
