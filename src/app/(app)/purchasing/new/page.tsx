import { notFound } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { todayIn } from "@/lib/format";
import { OrderBuilder } from "../order-builder";
import { loadSuggestions, nextDeliveryAfter } from "../load-suggestions";

export const metadata = { title: "Create vendor order" };

export default async function NewOrderPage({ searchParams }: { searchParams: Promise<{ vendor?: string; delivery?: string; next?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePermission("orders.create");
  if (!sp.vendor) notFound();
  const supabase = await createClient();
  const { data: vendor } = await supabase.from("vendors").select("id, name, minimum_order, order_cutoff, lead_time_days, delivery_days").eq("id", sp.vendor).single();
  if (!vendor) notFound();
  const today = todayIn(ctx.location.timezone);
  const delivery = sp.delivery ?? nextDeliveryAfter(vendor.delivery_days ?? [], today);
  const { rows, error } = await loadSuggestions(ctx.location.id, vendor.id, delivery, sp.next ?? null, null);
  return (
    <>
      <PageHeader title="Create vendor order" back={{ href: "/purchasing", label: "Purchasing" }} subtitle="Review the system suggestion, override where you know better, then submit." />
      <OrderBuilder key={`${delivery}-${sp.next}`} poId={null} vendor={vendor} deliveryDate={delivery} nextDeliveryDate={sp.next ?? null} rows={rows} error={error}
        showCost={can(ctx, "reports.view_cost")} canSubmit={can(ctx, "orders.submit")} />
    </>
  );
}
