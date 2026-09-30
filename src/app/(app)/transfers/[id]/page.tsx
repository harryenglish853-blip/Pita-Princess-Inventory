import { notFound } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/client";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { money, qty, dateTimeFmt } from "@/lib/format";
import { cancelTransfer, sendTransfer } from "../actions";
import { ReceiveTransfer } from "./receive-transfer";

export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("inventory.view");
  const supabase = await createClient();
  const [{ data: t }, { data: items }] = await Promise.all([
    supabase.from("inventory_transfers").select("*, from_loc:locations!inventory_transfers_from_location_id_fkey(code, name), to_loc:locations!inventory_transfers_to_location_id_fkey(code, name)").eq("id", id).single(),
    supabase.from("inventory_transfer_items").select("*, product:products(name), unit:units(code)").eq("transfer_id", id),
  ]);
  if (!t) notFound();
  const fromL = t.from_loc as { code: string; name: string }; const toL = t.to_loc as { code: string; name: string };
  const isSender = ctx.locations.some((l) => l.id === t.from_location_id && l.permissions.includes("inventory.transfer"));
  const isReceiver = ctx.locations.some((l) => l.id === t.to_location_id && l.permissions.includes("inventory.transfer"));
  const showCost = can(ctx, "reports.view_cost", t.from_location_id) || can(ctx, "reports.view_cost", t.to_location_id);
  return (
    <>
      <PageHeader back={{ href: "/transfers", label: "Transfers" }} title={`${t.transfer_number}: #${fromL.code} → #${toL.code}`}
        subtitle={<><StatusBadge status={t.status} /> {t.transfer_type === "location" ? `${fromL.name} to ${toL.name}` : "Storage transfer"}{t.sent_at ? ` · sent ${dateTimeFmt(t.sent_at)}` : ""}{t.reconciled_at ? ` · reconciled ${dateTimeFmt(t.reconciled_at)}` : ""}</>}
        actions={t.status === "draft" && isSender ? (<>
          <ActionButton action={cancelTransfer.bind(null, id)} variant="ghost" confirm="Cancel this transfer?">Cancel</ActionButton>
          <ActionButton action={sendTransfer.bind(null, id)} variant="primary" confirm={`Send to #${toL.code}? Inventory leaves #${fromL.code} now and is in transit until #${toL.code} receives it.`} confirmLabel="Send">Send transfer</ActionButton>
        </>) : null} />
      {["sent", "in_transit", "received"].includes(t.status) && isReceiver ? (
        <ReceiveTransfer transferId={id} lines={(items ?? []).map((i) => ({ id: i.id, name: (i.product as { name: string }).name, unit: (i.unit as { code: string }).code, sent: Number(i.qty_sent) }))} />
      ) : (
        <Card padded={false}>
          <table className="tbl">
            <thead><tr><th>Product</th><th className="num">Sent</th><th className="num">Received</th>{showCost ? <th className="num">Value</th> : null}</tr></thead>
            <tbody>{(items ?? []).map((i) => (
              <tr key={i.id}><td>{(i.product as { name: string }).name}</td><td className="num">{qty(i.qty_sent, (i.unit as { code: string }).code)}</td>
                <td className="num">{i.qty_received === null ? "—" : qty(i.qty_received, (i.unit as { code: string }).code)}</td>
                {showCost ? <td className="num">{i.unit_cost ? money(Number(i.qty_sent) * Number(i.unit_factor) * Number(i.unit_cost)) : "—"}</td> : null}</tr>
            ))}</tbody>
          </table>
        </Card>
      )}
    </>
  );
}
