import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { PageHeader, StatusBadge } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { dateTimeFmt } from "@/lib/format";
import { ReceiveScreen, type RLine } from "./receive-screen";
import type { ReceiptTotals } from "../actions";

export const metadata = { title: "Receive delivery" };

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("orders.view");
  const supabase = await createClient();
  const [{ data: r }, { data: items }, { data: totals }] = await Promise.all([
    supabase.from("receipts").select("*, vendor:vendors(id, name), po:purchase_orders(id, po_number), receiver:profiles!receipts_received_by_fkey(full_name), poster:profiles!receipts_posted_by_fkey(full_name)").eq("id", id).single(),
    supabase.from("receipt_items").select("*, product:products(name, product_number, catch_weight, lot_tracked, inventory_unit:units!products_inventory_unit_id_fkey(code)), unit:units(code), vendor_product:vendor_products(vendor_item_number)").eq("receipt_id", id).order("sort").order("created_at"),
    supabase.rpc("receipt_totals", { p_receipt: id }),
  ]);
  if (!r) notFound();
  const vendor = r.vendor as { id: string; name: string };
  const [{ data: storages }, { data: guide }, { data: placements }, { data: allProducts }] = await Promise.all([
    supabase.from("storage_locations").select("id, name").eq("location_id", r.location_id).eq("active", true).order("sort_order"),
    supabase.from("vendor_products").select("id, product_id, vendor_item_number, product:products(id, name)").eq("vendor_id", vendor.id).eq("active", true),
    supabase.from("product_storage_locations").select("product_id, storage_location_id, sort_order").eq("location_id", r.location_id).eq("active", true),
    supabase.from("products").select("id, name").eq("active", true).order("name"),
  ]);
  const lines: RLine[] = (items ?? []).map((i) => {
    const p = i.product as { name: string; product_number: string; catch_weight: boolean; lot_tracked: boolean; inventory_unit: { code: string } };
    return {
      ...i, product_name: p.name, product_number: p.product_number, inventory_unit: p.inventory_unit.code, unit_code: (i.unit as { code: string }).code,
      vendor_item_number: (i.vendor_product as { vendor_item_number: string } | null)?.vendor_item_number ?? null,
      catch_weight: p.catch_weight, lot_tracked: p.lot_tracked,
      default_storage_id: (placements ?? []).filter((x) => x.product_id === i.product_id).sort((a, b) => a.sort_order - b.sort_order)[0]?.storage_location_id ?? null,
      ordered_qty: Number(i.ordered_qty), received_qty: i.received_qty === null ? null : Number(i.received_qty), invoiced_qty: i.invoiced_qty === null ? null : Number(i.invoiced_qty),
      rejected_qty: Number(i.rejected_qty), damaged_qty: Number(i.damaged_qty), unit_factor: Number(i.unit_factor),
      contract_price: i.contract_price === null ? null : Number(i.contract_price), invoice_price: i.invoice_price === null ? null : Number(i.invoice_price),
      invoice_extended: i.invoice_extended === null ? null : Number(i.invoice_extended), catch_weight_qty: i.catch_weight_qty === null ? null : Number(i.catch_weight_qty),
      temperature: i.temperature === null ? null : Number(i.temperature), temp_min: i.temp_min === null ? null : Number(i.temp_min), temp_max: i.temp_max === null ? null : Number(i.temp_max),
    } as RLine;
  });
  const products = Array.from(new Map((guide ?? []).map((g) => [g.product_id, { id: g.product_id, name: (g.product as unknown as { name: string }).name, vendor_product_id: g.id, vendor_item_number: g.vendor_item_number }])).values())
    .sort((a, b) => a.name.localeCompare(b.name));
  const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  const po = r.po as { id: string; po_number: string } | null;
  return (
    <>
      <PageHeader back={{ href: "/receiving", label: "Receiving" }}
        title={po ? `Receive ${vendor.name}` : `${vendor.name} delivery`}
        subtitle={<><StatusBadge status={r.status} label={r.status === "draft" ? "Receiving" : r.status === "received" ? "Awaiting reconciliation" : undefined} /> {r.receipt_number}{po ? <> · <Link className="text-brand" href={`/purchasing/${po.id}`}>{po.po_number}</Link></> : null}{r.received_at ? ` · received ${dateTimeFmt(r.received_at)} by ${(r.receiver as { full_name: string } | null)?.full_name ?? ""}` : ""}{r.posted_at ? ` · posted ${dateTimeFmt(r.posted_at)} by ${(r.poster as { full_name: string } | null)?.full_name ?? ""}` : ""}{r.override_reason ? ` · override: ${r.override_reason}` : ""}</>}
        actions={<PrintButton />} />
      <ReceiveScreen
        key={`${r.updated_at}-${lines.length}`}
        receiptId={id} status={r.status} vendorName={vendor.name} poNumber={po?.po_number ?? null}
        initialHeader={{ delivery_date: s(r.delivery_date), invoice_number: s(r.invoice_number), invoice_date: s(r.invoice_date), invoice_total: s(r.invoice_total),
          tax: s(r.tax), freight: s(r.freight), fuel_surcharge: s(r.fuel_surcharge), misc_fees: s(r.misc_fees), credits: s(r.credits), notes: s(r.notes) }}
        initialLines={lines} initialTotals={totals as ReceiptTotals} storages={storages ?? []} products={products}
        otherProducts={(allProducts ?? []).filter((x) => !products.some((g) => g.id === x.id))}
        canReceive={can(ctx, "orders.receive")} canReconcile={can(ctx, "orders.reconcile")} canOverride={can(ctx, "orders.reconcile_override")}
      />
    </>
  );
}
