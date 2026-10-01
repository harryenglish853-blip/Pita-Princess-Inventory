import Link from "next/link";
import { requirePermission, can, orderingEnabled } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/client";
import { Card, EmptyState, PageHeader, StatusBadge } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { dateFmt, money, todayIn } from "@/lib/format";
import { startReceipt } from "../purchasing/actions";
import { NewReceiptButton } from "./new-receipt";

export const metadata = { title: "Receiving" };

export default async function ReceivingPage({ searchParams }: { searchParams: Promise<{ log?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePermission("orders.receive");
  const ordering = orderingEnabled(ctx);
  const supabase = await createClient();
  const today = todayIn(ctx.location.timezone);
  const [{ data: expected }, { data: receipts }, { data: vendors }] = await Promise.all([
    supabase.from("purchase_orders").select("id, po_number, status, expected_delivery_date, vendor:vendors(name)").eq("location_id", ctx.location.id)
      .in("status", ["submitted", "confirmed", "back_ordered", "partially_received"]).order("expected_delivery_date"),
    supabase.from("receipts").select("id, receipt_number, status, invoice_number, invoice_total, delivery_date, received_at, posted_at, purchase_order_id, vendor:vendors(name), po:purchase_orders(po_number)")
      .eq("location_id", ctx.location.id).order("created_at", { ascending: false }).limit(300),
    // Vendors this store buys from (store settings can switch a vendor off)
    supabase.from("location_vendor_settings").select("id:vendor_id, name:vendor_name").eq("location_id", ctx.location.id).eq("active", true).order("vendor_name"),
  ]);
  const inProgress = (receipts ?? []).filter((r) => ["draft", "received"].includes(r.status));
  const openByPo = new Map(inProgress.filter((r) => r.purchase_order_id).map((r) => [r.purchase_order_id!, r.id]));
  const history = (receipts ?? []).map((r) => ({ ...r, vendor_name: (r.vendor as unknown as { name: string }).name, po_number: (r.po as unknown as { po_number: string } | null)?.po_number ?? "—" }));
  return (
    <>
      <PageHeader title="Receiving"
        subtitle={ordering ? "Receive deliveries, check them against the order and invoice, then reconcile" : "Record each delivery from its invoice: what arrived, what it cost. Stock and costs update when it's posted."}
        actions={<NewReceiptButton vendors={vendors ?? []} label={ordering ? "Receive without PO" : "Log a delivery"} primary={!ordering} openFor={sp.log} />} />
      <div className="grid gap-4 lg:grid-cols-2">
        {ordering || expected?.length ? <Card title="Expected deliveries" padded={false}>
          {expected?.length ? (
            <ul className="divide-y divide-border">
              {expected.map((po) => (
                <li key={po.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="font-medium">{(po.vendor as unknown as { name: string }).name} <span className="text-sm text-muted">· {po.po_number}</span></div>
                    <div className={`text-xs ${po.expected_delivery_date < today ? "text-danger" : "text-muted"}`}>
                      {po.expected_delivery_date === today ? "Due today" : po.expected_delivery_date < today ? `Late — expected ${dateFmt(po.expected_delivery_date)}` : `Expected ${dateFmt(po.expected_delivery_date)}`} · <StatusBadge status={po.status} />
                    </div>
                  </div>
                  {openByPo.has(po.id) ? <Link className="text-sm font-medium text-brand" href={`/receiving/${openByPo.get(po.id)}`}>Continue →</Link>
                    : <ActionButton variant="primary" size="sm" action={startReceipt.bind(null, po.id, undefined)} redirectTo="/receiving/{id}">Receive</ActionButton>}
                </li>
              ))}
            </ul>
          ) : <div className="p-4"><EmptyState title="No deliveries expected" /></div>}
        </Card> : null}
        <Card title={ordering ? "Needs reconciliation" : "In progress"} padded={false} className={ordering || expected?.length ? undefined : "lg:col-span-2"}>
          {inProgress.length ? (
            <ul className="divide-y divide-border">
              {inProgress.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="font-medium">{(r.vendor as unknown as { name: string }).name} <span className="text-sm text-muted">· {r.receipt_number}</span></div>
                    <div className="text-xs text-muted">{r.invoice_number ? `Invoice ${r.invoice_number}` : "No invoice entered"} · {dateFmt(r.delivery_date)} · <StatusBadge status={r.status} label={r.status === "draft" ? "Receiving" : "Awaiting reconciliation"} /></div>
                  </div>
                  <Link className="text-sm font-medium text-brand" href={`/receiving/${r.id}`}>{r.status === "draft" ? "Continue →" : can(ctx, "orders.reconcile") ? "Reconcile →" : "Open →"}</Link>
                </li>
              ))}
            </ul>
          ) : <div className="p-4"><EmptyState title="Nothing waiting">{ordering ? null : "When a truck arrives, tap Log a delivery."}</EmptyState></div>}
        </Card>
      </div>
      <h2 className="mb-2 mt-6 text-sm font-semibold text-muted">RECEIVING HISTORY</h2>
      <DataTable id="receipts" rows={history} exportName="receipts" columns={[
        { key: "receipt_number", label: "Receipt", href: "/receiving/{id}" },
        { key: "vendor_name", label: "Vendor", filterable: true },
        ...(ordering ? [{ key: "po_number", label: "PO" }] : []),
        { key: "invoice_number", label: "Invoice #" },
        { key: "delivery_date", label: "Delivered", format: "date" },
        { key: "invoice_total", label: "Invoice total", format: "money", total: true },
        { key: "status", label: "Status", filterable: true },
        { key: "posted_at", label: "Posted", format: "datetime" },
      ]} />
      <p className="sr-only">{money(0)}</p>
    </>
  );
}
