import { notFound } from "next/navigation";
import { requireContext, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/client";
import { Card, LinkButton, Notice, PageHeader, cx } from "@/components/ui";
import { dateFmt, dateTimeFmt, money, qty } from "@/lib/format";
import { CommissaryStatus, COMMISSARY_STEPS } from "../status";
import { setCommissaryStatus, submitCommissaryOrder } from "../actions";
import { ShipForm, ReceiveForm, type Line } from "./forms";

export const metadata = { title: "Commissary order" };

export default async function CommissaryOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  const supabase = await createClient();
  const [{ data: raw }, { data: lines }] = await Promise.all([
    supabase.rpc("get_commissary_order", { p_order: id }),
    supabase.rpc("commissary_order_lines", { p_order: id }),
  ]);
  if (!raw) notFound();
  type O = { id: string; order_number: string; status: string; needed_date: string; notes: string | null; location_id: string; commissary_location_id: string;
    cancel_reason: string | null; discrepancy_value: number | null; submitted_at: string | null; accepted_at: string | null; preparing_at: string | null;
    ready_at: string | null; shipped_at: string | null; received_at: string | null;
    restaurant: { code: string; name: string; timezone: string }; commissary: { code: string; name: string } };
  const o = raw as O;
  const ls = (lines ?? []) as Line[];
  const tz = o.restaurant.timezone;
  const atRestaurant = ctx.locations.some((l) => l.id === o.location_id);
  const canOrder = can(ctx, "orders.create", o.location_id);
  const canReceive = can(ctx, "orders.receive", o.location_id);
  const canFill = can(ctx, "inventory.transfer", o.commissary_location_id);
  const showCost = ls.some((l) => l.unit_cost !== null);
  const stepAt: Record<string, string | null> = { submitted: o.submitted_at, accepted: o.accepted_at, preparing: o.preparing_at, ready: o.ready_at, in_transit: o.shipped_at, received: o.received_at };
  const reached = o.status === "cancelled" ? -1 : COMMISSARY_STEPS.indexOf(o.status as (typeof COMMISSARY_STEPS)[number]);
  const r = o.restaurant;
  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2">{o.order_number} <CommissaryStatus status={o.status} /></span>} back={{ href: "/commissary", label: "Commissary" }}
        subtitle={`#${r.code} ${r.name} ← ${o.commissary.name} · needed ${dateFmt(o.needed_date)}`}
        actions={<>
          {o.status === "draft" && canOrder ? <LinkButton href={`/commissary/new?edit=${o.id}`}>Edit</LinkButton> : null}
          {o.status === "draft" && canOrder ? <ActionButton variant="primary" action={submitCommissaryOrder.bind(null, o.id)}>Submit to commissary</ActionButton> : null}
          {canFill && o.status === "submitted" ? <ActionButton variant="primary" action={setCommissaryStatus.bind(null, o.id, "accepted", undefined)}>Accept</ActionButton> : null}
          {canFill && ["submitted", "accepted"].includes(o.status) ? <ActionButton action={setCommissaryStatus.bind(null, o.id, "preparing", undefined)}>Preparing</ActionButton> : null}
          {canFill && ["submitted", "accepted", "preparing"].includes(o.status) ? <ActionButton action={setCommissaryStatus.bind(null, o.id, "ready", undefined)}>Ready</ActionButton> : null}
          {["draft", "submitted", "accepted", "preparing", "ready"].includes(o.status) && (canOrder || canFill)
            ? <ActionButton variant="ghost" action={setCommissaryStatus.bind(null, o.id, "cancelled")} prompt={o.status === "draft" ? undefined : "Why is it cancelled?"}
                confirm={`Cancel ${o.order_number}?`} confirmLabel="Cancel order">Cancel</ActionButton> : null}
        </>} />

      {o.status !== "draft" && o.status !== "cancelled" ? (
        <ol className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label="Order progress">
          {COMMISSARY_STEPS.map((s, i) => (
            <li key={s} className={cx("rounded-md border px-2 py-1.5 text-center text-xs", i <= reached ? "border-brand bg-brand-soft text-brand" : "border-border text-muted")}>
              <div className="font-semibold">{s === "in_transit" ? "IN TRANSIT" : s.toUpperCase()}</div>
              <div>{stepAt[s] ? dateTimeFmt(stepAt[s], tz) : "—"}</div>
            </li>
          ))}
        </ol>
      ) : null}
      {o.status === "cancelled" ? <div className="mb-4"><Notice tone="neutral" title="Cancelled">{o.cancel_reason ?? ""}</Notice></div> : null}
      {o.discrepancy_value !== null ? <div className="mb-4"><Notice tone="warning" title="RECEIVED WITH DIFFERENCES">
        The restaurant received a different quantity than ordered{showCost ? ` (value ${money(o.discrepancy_value, { sign: true })})` : ""}. Management was alerted. The commissary&apos;s books only count what the restaurant received.</Notice></div> : null}
      {o.notes ? <div className="mb-4"><Notice tone="info" title="Notes">{o.notes}</Notice></div> : null}

      {o.status === "in_transit" && canReceive && atRestaurant ? <ReceiveForm orderId={o.id} lines={ls} /> : null}
      {canFill && ["submitted", "accepted", "preparing", "ready"].includes(o.status) ? <ShipForm orderId={o.id} lines={ls} /> : null}

      <Card title="Items" padded={false} className="mt-4">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Shipped</th><th className="num">Received</th><th className="num">Difference</th>{showCost ? <th className="num">Value received</th> : null}</tr></thead>
            <tbody>{ls.map((l) => {
              const diff = l.qty_received !== null ? Number(l.qty_received) - Number(l.qty_ordered) : null;
              return (
                <tr key={l.id}>
                  <td className="font-medium">{l.product_name}<div className="text-xs text-muted">1 {l.unit_code} = {Number(l.unit_factor)} {l.inventory_unit}</div></td>
                  <td className="num">{qty(l.qty_ordered, l.unit_code)}</td>
                  <td className="num">{l.qty_shipped !== null ? qty(l.qty_shipped, l.unit_code) : "—"}</td>
                  <td className="num">{l.qty_received !== null ? qty(l.qty_received, l.unit_code) : "—"}</td>
                  <td className={cx("num", diff ? "font-semibold text-danger" : "")}>{diff === null ? "—" : diff === 0 ? "0" : `${diff > 0 ? "+" : ""}${qty(diff, l.unit_code)}`}</td>
                  {showCost ? <td className="num">{l.qty_received !== null && l.unit_cost !== null ? money(Number(l.qty_received) * Number(l.unit_factor) * Number(l.unit_cost)) : "—"}</td> : null}
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
