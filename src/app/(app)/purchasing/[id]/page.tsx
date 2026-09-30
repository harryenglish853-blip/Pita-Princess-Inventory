import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ModalButton } from "@/components/client";
import { Badge, Card, LinkButton, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { PrintButton } from "@/components/print-button";
import { dateFmt, dateTimeFmt, money, qty } from "@/lib/format";
import { setPoStatus, startReceipt } from "../actions";
import { Explanation } from "../order-builder";
import type { SuggestionRow } from "../load-suggestions";

export default async function PoPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("orders.view");
  const supabase = await createClient();
  const [{ data: po }, { data: items }, { data: receipts }] = await Promise.all([
    supabase.from("purchase_orders").select("*, vendor:vendors(*), creator:profiles!purchase_orders_created_by_fkey(full_name), submitter:profiles!purchase_orders_submitted_by_fkey(full_name), location:locations(code, name, address_line1, city, state)").eq("id", id).single(),
    supabase.from("purchase_order_items").select("*, product:products(id, name, product_number, inventory_unit:units!products_inventory_unit_id_fkey(code)), vendor_product:vendor_products(vendor_item_number, pack_size), unit:units(code)").eq("po_id", id).order("sort"),
    supabase.from("receipts").select("id, receipt_number, status, invoice_number, delivery_date").eq("purchase_order_id", id).order("created_at"),
  ]);
  if (!po) notFound();
  const vendor = po.vendor as { id: string; name: string; ordering_email: string | null; account_number: string | null; minimum_order: number };
  const showCost = can(ctx, "reports.view_cost");
  const lines = items ?? [];
  const total = lines.reduce((s, l) => s + Number(l.extended_price), 0);
  const changed = lines.filter((l) => l.suggested_qty !== null && Number(l.suggested_qty) !== Number(l.order_qty));
  const editable = ["draft", "ready_to_submit"].includes(po.status);
  const receivable = ["submitted", "confirmed", "partially_received", "back_ordered", "invoice_received", "ready_to_reconcile"].includes(po.status);
  const openReceipt = (receipts ?? []).find((r) => ["draft", "received"].includes(r.status));
  const loc = po.location as { code: string; name: string; address_line1: string | null; city: string | null; state: string | null };
  const body = [
    `Purchase order ${po.po_number}`, `Account: ${vendor.account_number ?? ""}`, `Ship to: #${loc.code} ${loc.name}, ${loc.address_line1 ?? ""} ${loc.city ?? ""} ${loc.state ?? ""}`,
    `Requested delivery: ${po.expected_delivery_date}`, "", ...lines.filter((l) => Number(l.order_qty) > 0).map((l) => `${Number(l.order_qty)} ${(l.unit as { code: string }).code}  ${(l.vendor_product as { vendor_item_number: string } | null)?.vendor_item_number ?? ""}  ${(l.product as { name: string }).name}`),
    "", po.notes ?? "",
  ].join("\n");
  const mailto = `mailto:${vendor.ordering_email ?? ""}?subject=${encodeURIComponent(`${po.po_number} — ${loc.name}`)}&body=${encodeURIComponent(body)}`;

  return (
    <>
      <PageHeader back={{ href: "/purchasing", label: "Purchasing" }}
        title={`${po.po_number} · ${vendor.name}`}
        subtitle={<><StatusBadge status={po.status} /> Delivery {dateFmt(po.expected_delivery_date)}{po.next_delivery_date ? ` · covers until ${dateFmt(po.next_delivery_date)}` : ""} · created by {(po.creator as { full_name: string } | null)?.full_name}{po.submitted_at ? ` · submitted ${dateTimeFmt(po.submitted_at)} by ${(po.submitter as { full_name: string } | null)?.full_name}` : ""}{po.confirmation_number ? ` · confirmation ${po.confirmation_number}` : ""}</>}
        actions={<div className="no-print flex flex-wrap gap-2">
          {editable && can(ctx, "orders.create") ? <LinkButton href={`/purchasing/${id}/edit`}>Edit order</LinkButton> : null}
          {po.status === "draft" && can(ctx, "orders.create") ? <ActionButton action={setPoStatus.bind(null, id, "ready_to_submit")}>Mark ready</ActionButton> : null}
          {editable && can(ctx, "orders.submit") ? (
            <ActionButton variant="primary" action={setPoStatus.bind(null, id, "submitted")} confirmLabel="Submit order"
              confirm={<p>Submit {po.po_number} to <b>{vendor.name}</b>{showCost ? ` for ${money(total)}` : ""}? The order will be locked.{total < Number(vendor.minimum_order) ? ` It is below the ${money(vendor.minimum_order)} minimum.` : ""}</p>}>Submit order</ActionButton>
          ) : null}
          {po.status === "submitted" && can(ctx, "orders.submit") ? <ActionButton action={setPoStatus.bind(null, id, "confirmed")} prompt="Vendor confirmation number" confirm="Record the vendor's confirmation." confirmLabel="Confirm order">Vendor confirmed</ActionButton> : null}
          {receivable && can(ctx, "orders.receive") ? (
            openReceipt ? <LinkButton variant="primary" href={`/receiving/${openReceipt.id}`}>Continue receiving</LinkButton>
              : <ActionButton variant="primary" action={startReceipt.bind(null, id, undefined)} redirectTo="/receiving/{id}">Receive delivery</ActionButton>
          ) : null}
          {["draft", "ready_to_submit", "submitted", "confirmed", "back_ordered"].includes(po.status) && can(ctx, "orders.create") ? (
            <ActionButton variant="ghost" action={setPoStatus.bind(null, id, "cancelled")} prompt="Reason for cancelling" confirm={`Cancel ${po.po_number}?`} confirmLabel="Cancel order">Cancel</ActionButton>
          ) : null}
          <a className="inline-flex h-10 items-center rounded-md border border-border-strong px-4 text-sm" href={mailto}>Email vendor</a>
          <PrintButton />
        </div>} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Lines" value={lines.filter((l) => Number(l.order_qty) > 0).length} />
        {showCost ? <Stat label="Order total" value={money(total)} sub={total < Number(vendor.minimum_order) ? `Below ${money(vendor.minimum_order)} minimum` : undefined} tone={total < Number(vendor.minimum_order) ? "warning" : undefined} /> : null}
        <Stat label="Manager changes" value={changed.length} sub="vs system suggestion" />
        <Stat label="Receipts" value={(receipts ?? []).length} />
      </div>
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Product</th><th>Vendor #</th><th className="num">System suggestion</th><th className="num">Manager order</th><th className="num">Received</th><th className="num">Back ordered</th>{showCost ? <><th className="num">Price</th><th className="num">Extended</th></> : null}</tr></thead>
            <tbody>
              {lines.map((l) => {
                const p = l.product as { id: string; name: string; product_number: string; inventory_unit: { code: string } };
                const u = (l.unit as { code: string }).code;
                const diff = l.suggested_qty !== null && Number(l.suggested_qty) !== Number(l.order_qty);
                return (
                  <tr key={l.id}>
                    <td><Link href={`/inventory/items/${p.id}`} className="font-medium text-brand">{p.name}</Link><div className="text-[11px] text-muted">{u} = {Number(l.unit_factor)} {p.inventory_unit.code}</div></td>
                    <td className="font-mono text-xs">{(l.vendor_product as { vendor_item_number: string } | null)?.vendor_item_number ?? "—"}</td>
                    <td className="num">
                      {l.suggested_qty === null ? "—" : <>{qty(l.suggested_qty, u)} {l.suggestion ? (
                        <span className="no-print inline-block"><ModalButton size="sm" variant="ghost" label="Why?" title={`Why ${Number(l.suggested_qty)} ${u}? — ${p.name}`}>
                          <Explanation row={{ ...(l as unknown as SuggestionRow), explanation: l.suggestion as Record<string, unknown>, product_name: p.name, purchase_unit: u, inventory_unit: p.inventory_unit.code, unit_factor: Number(l.unit_factor) }} />
                        </ModalButton></span>) : null}</>}
                    </td>
                    <td className="num font-semibold">{qty(l.order_qty, u)} {diff ? <Badge tone="warning">{Number(l.order_qty) > Number(l.suggested_qty) ? "+" : ""}{Number(l.order_qty) - Number(l.suggested_qty)}</Badge> : null}</td>
                    <td className="num">{Number(l.received_qty) ? qty(l.received_qty, u) : "—"}</td>
                    <td className="num">{Number(l.back_ordered_qty) ? <Badge tone="warning">{qty(l.back_ordered_qty, u)}</Badge> : "—"}</td>
                    {showCost ? <><td className="num">{money(l.unit_price)}</td><td className="num">{money(l.extended_price)}</td></> : null}
                  </tr>
                );
              })}
            </tbody>
            {showCost ? <tfoot><tr className="font-semibold"><td colSpan={7}>Total</td><td className="num">{money(total)}</td></tr></tfoot> : null}
          </table>
        </div>
      </Card>
      {po.notes ? <Card title="Notes" className="mt-4"><p className="text-sm">{po.notes}</p></Card> : null}
      {receipts?.length ? (
        <Card title="Receipts" className="mt-4">
          <ul className="space-y-1 text-sm">{receipts.map((r) => <li key={r.id} className="flex gap-3"><Link className="text-brand" href={`/receiving/${r.id}`}>{r.receipt_number}</Link><span>{r.invoice_number ?? "no invoice yet"}</span><span className="text-muted">{dateFmt(r.delivery_date)}</span><StatusBadge status={r.status} /></li>)}</ul>
        </Card>
      ) : null}
      {po.cancel_reason ? <Card title="Cancelled" className="mt-4"><p className="text-sm">{po.cancel_reason}</p></Card> : null}
    </>
  );
}
