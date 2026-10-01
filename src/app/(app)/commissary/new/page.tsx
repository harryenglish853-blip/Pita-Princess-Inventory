import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { EmptyState, LinkButton, PageHeader } from "@/components/ui";
import type { SuggestionRow } from "../../purchasing/load-suggestions";
import { loadSchedule } from "../../ordering/schedule";
import { CommissaryOrderForm, type FormRow } from "./order-form";

export const metadata = { title: "Commissary order" };

export default async function NewCommissaryOrder({ searchParams }: { searchParams: Promise<{ edit?: string; needed?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePermission("orders.create");
  const supabase = await createClient();
  const { vendors } = await loadSchedule(ctx.location.id);
  const commissaries = vendors.filter((v) => v.kind === "commissary");
  if (!commissaries.length) {
    return (<><PageHeader title="New commissary order" back={{ href: "/commissary", label: "Commissary" }} />
      <EmptyState title="No commissary set up" action={<LinkButton href="/vendors">Vendors</LinkButton>}>Add a vendor of type Commissary linked to your central kitchen location.</EmptyState></>);
  }
  let draft: { id: string; vendor_id: string; needed_date: string; notes: string | null; status: string; location_id: string } | null = null;
  let draftLines: { product_id: string; unit_id: string; qty_ordered: number; notes: string | null }[] = [];
  if (sp.edit) {
    const [{ data: o }, { data: l }] = await Promise.all([
      supabase.from("commissary_orders").select("id, vendor_id, needed_date, notes, status, location_id").eq("id", sp.edit).maybeSingle(),
      supabase.from("commissary_order_items").select("product_id, unit_id, qty_ordered, notes").eq("order_id", sp.edit),
    ]);
    if (!o || o.status !== "draft" || o.location_id !== ctx.location.id) notFound();
    draft = o; draftLines = l ?? [];
  }
  const v = commissaries.find((c) => c.vendor_id === draft?.vendor_id) ?? commissaries[0];
  const needed = sp.needed ?? draft?.needed_date ?? v.delivery_date ?? new Date().toISOString().slice(0, 10);
  const { data: sug, error } = await supabase.rpc("suggest_order", {
    p_location: ctx.location.id, p_vendor: v.vendor_id, p_delivery_date: needed, p_next_delivery_date: null, p_exclude_po: null,
  });
  const rows = (sug ?? []) as SuggestionRow[];
  const ids = rows.map((r) => r.product_id);
  const { data: units } = ids.length ? await supabase.from("product_unit_options").select("product_id, unit_id, unit_code, factor, priority, use_for_purchase, use_for_count")
    .in("product_id", ids).lte("priority", 1) : { data: [] };
  const formRows: FormRow[] = rows.map((r) => {
    const d = draftLines.find((x) => x.product_id === r.product_id);
    return {
      product_id: r.product_id, name: r.product_name, inventory_unit: r.inventory_unit, on_hand: Number(r.on_hand), incoming: Number(r.on_order),
      suggested: Number(r.suggested_qty), suggested_unit_id: r.purchase_unit_id, explanation: r,
      units: (units ?? []).filter((u) => u.product_id === r.product_id).map((u) => ({ id: u.unit_id, code: u.unit_code, factor: Number(u.factor) })),
      unit_id: d?.unit_id ?? r.purchase_unit_id, qty: d ? String(Number(d.qty_ordered)) : Number(r.suggested_qty) > 0 ? String(Number(r.suggested_qty)) : "",
      notes: d?.notes ?? "",
    };
  });
  return (
    <>
      <PageHeader title={draft ? "Edit commissary order" : "New commissary order"} back={{ href: "/commissary", label: "Commissary" }}
        subtitle={`From ${v.vendor_name}. Suggested quantities cover expected use until the following delivery.`} />
      <CommissaryOrderForm key={needed} orderId={draft?.id ?? null} vendorId={v.vendor_id} neededDate={needed} notes={draft?.notes ?? ""} rows={formRows} error={error?.message ?? null} />
    </>
  );
}
