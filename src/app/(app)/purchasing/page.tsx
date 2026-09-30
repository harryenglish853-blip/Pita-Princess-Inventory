import Link from "next/link";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { money, dateFmt, todayIn } from "@/lib/format";
import { dayNames } from "../vendors/vendor-form";
import { nextDeliveryAfter } from "./load-suggestions";

export const metadata = { title: "Purchasing" };

export default async function PurchasingPage() {
  const ctx = await requirePermission("orders.view");
  const supabase = await createClient();
  const [{ data: pos }, { data: vendors }, { data: lines }] = await Promise.all([
    supabase.from("purchase_orders").select("id, po_number, status, order_date, expected_delivery_date, vendor_id, vendor:vendors(name), creator:profiles!purchase_orders_created_by_fkey(full_name)")
      .eq("location_id", ctx.location.id).order("created_at", { ascending: false }).limit(300),
    // This store's effective schedule (store overrides over company settings); vendors the store doesn't use are hidden
    supabase.from("location_vendor_settings").select("id:vendor_id, name:vendor_name, delivery_days, order_cutoff, minimum_order").eq("location_id", ctx.location.id).eq("active", true).order("vendor_name"),
    supabase.from("purchase_order_items").select("po_id, extended_price, suggested_qty, order_qty"),
  ]);
  const today = todayIn(ctx.location.timezone);
  const totals = new Map<string, { total: number; lines: number; changed: number }>();
  for (const l of lines ?? []) {
    const t = totals.get(l.po_id) ?? { total: 0, lines: 0, changed: 0 };
    t.total += Number(l.extended_price); t.lines += 1; if (l.suggested_qty !== null && Number(l.suggested_qty) !== Number(l.order_qty)) t.changed += 1;
    totals.set(l.po_id, t);
  }
  const rows = (pos ?? []).map((p) => ({
    ...p, vendor_name: (p.vendor as unknown as { name: string }).name, total: totals.get(p.id)?.total ?? 0, lines: totals.get(p.id)?.lines ?? 0,
    overrides: totals.get(p.id)?.changed ?? 0, created_by: (p.creator as unknown as { full_name: string } | null)?.full_name, status_label: p.status.replace(/_/g, " "),
  }));
  const open = rows.filter((r) => !["posted", "cancelled"].includes(r.status));
  return (
    <>
      <PageHeader title="Purchasing" subtitle="Suggested orders, purchase orders and vendor schedules" />
      {can(ctx, "orders.create") ? (
        <div className="mb-5">
          <h2 className="mb-2 text-sm font-semibold text-muted">CREATE VENDOR ORDER</h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {(vendors ?? []).map((v) => {
              const next = nextDeliveryAfter(v.delivery_days ?? [], today);
              const draft = open.find((o) => o.vendor_id === v.id && ["draft", "ready_to_submit"].includes(o.status));
              return (
                <Link key={v.id} href={draft ? `/purchasing/${draft.id}` : `/purchasing/new?vendor=${v.id}`} className="rounded-lg border border-border bg-surface p-3 hover:border-brand">
                  <div className="font-medium">{v.name}</div>
                  <div className="text-xs text-muted">Delivers {dayNames(v.delivery_days)} · cutoff {v.order_cutoff?.slice(0, 5) ?? "—"}</div>
                  <div className="mt-2 text-sm">{draft ? <span className="text-warning">Draft {draft.po_number} in progress →</span> : <>Next delivery <b>{dateFmt(next)}</b> →</>}</div>
                </Link>
              );
            })}
          </div>
        </div>
      ) : null}
      {open.length ? (
        <Card title={`Open orders (${open.length})`} padded={false} className="mb-5">
          <table className="tbl">
            <thead><tr><th>PO</th><th>Vendor</th><th>Delivery</th><th>Status</th><th className="num">Lines</th><th className="num">Total</th></tr></thead>
            <tbody>
              {open.map((o) => (
                <tr key={o.id}>
                  <td><Link className="font-medium text-brand" href={`/purchasing/${o.id}`}>{o.po_number}</Link></td><td>{o.vendor_name}</td>
                  <td className={o.expected_delivery_date < today && ["submitted", "confirmed"].includes(o.status) ? "text-danger" : ""}>{dateFmt(o.expected_delivery_date)}{o.expected_delivery_date < today && ["submitted", "confirmed"].includes(o.status) ? " · late" : ""}</td>
                  <td><StatusBadge status={o.status} /></td><td className="num">{o.lines}</td><td className="num">{money(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <h2 className="mb-2 text-sm font-semibold text-muted">ALL ORDERS</h2>
      <DataTable id="purchase-orders" rows={rows} exportName="purchase-orders" columns={[
        { key: "po_number", label: "PO #", href: "/purchasing/{id}" },
        { key: "vendor_name", label: "Vendor", filterable: true },
        { key: "order_date", label: "Ordered", format: "date" },
        { key: "expected_delivery_date", label: "Delivery", format: "date" },
        { key: "status_label", label: "Status", filterable: true },
        { key: "lines", label: "Lines", format: "number" },
        { key: "overrides", label: "Manager changes", format: "number" },
        { key: "total", label: "Total", format: "money", total: true },
        { key: "created_by", label: "Created by", filterable: true },
      ]} />
    </>
  );
}
