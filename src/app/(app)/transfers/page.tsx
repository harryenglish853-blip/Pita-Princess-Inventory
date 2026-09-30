import Link from "next/link";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader, StatusBadge } from "@/components/ui";
import { dateTimeFmt } from "@/lib/format";
import { TransferForm } from "./transfer-form";

export const metadata = { title: "Transfers" };

export default async function TransfersPage() {
  const ctx = await requirePermission("inventory.view");
  const supabase = await createClient();
  const [{ data: transfers }, { data: storages }, { data: products }, { data: units }] = await Promise.all([
    supabase.from("inventory_transfers").select("id, transfer_number, transfer_type, status, from_location_id, to_location_id, created_at, sent_at, from_storage:storage_locations!inventory_transfers_from_storage_id_fkey(name), to_storage:storage_locations!inventory_transfers_to_storage_id_fkey(name), from_loc:locations!inventory_transfers_from_location_id_fkey(code, name), to_loc:locations!inventory_transfers_to_location_id_fkey(code, name)")
      .or(`from_location_id.eq.${ctx.location.id},to_location_id.eq.${ctx.location.id}`).order("created_at", { ascending: false }).limit(100),
    supabase.from("storage_locations").select("id, name").eq("location_id", ctx.location.id).eq("active", true).order("sort_order"),
    supabase.from("products").select("id, name, inventory_unit_id").eq("active", true).order("name"),
    supabase.from("product_unit_options").select("product_id, unit_id, unit_code").or("is_inventory_unit.eq.true,use_for_count.eq.true"),
  ]);
  const others = ctx.locations.filter((l) => l.id !== ctx.location.id && l.organization_id === ctx.organizationId);
  const name = (x: unknown) => (x as { name: string } | null)?.name;
  const loc = (x: unknown) => { const l = x as { code: string; name: string } | null; return l ? `#${l.code} ${l.name}` : ""; };
  return (
    <>
      <PageHeader title="Transfers" subtitle="Move stock between storage areas or restaurants. Receiving restaurants gain stock only after reconciling." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        {can(ctx, "inventory.transfer") ? (
          <TransferForm storages={storages ?? []} locations={others.map((l) => ({ id: l.id, label: `#${l.code} ${l.name}` }))}
            products={(products ?? []).map((p) => ({ id: p.id, name: p.name, unit_id: p.inventory_unit_id }))}
            units={(units ?? []).map((u) => ({ product_id: u.product_id, unit_id: u.unit_id, code: u.unit_code }))} canLocation={others.length > 0} />
        ) : <div />}
        <Card title="Transfer history" padded={false}>
          <table className="tbl">
            <thead><tr><th>#</th><th>Type</th><th>From</th><th>To</th><th>Status</th><th>When</th></tr></thead>
            <tbody>
              {(transfers ?? []).map((t) => (
                <tr key={t.id}>
                  <td><Link className="font-medium text-brand" href={`/transfers/${t.id}`}>{t.transfer_number}</Link></td>
                  <td>{t.transfer_type === "storage" ? "Storage" : t.to_location_id === ctx.location.id ? "Inbound" : "Outbound"}</td>
                  <td>{t.transfer_type === "storage" ? name(t.from_storage) : loc(t.from_loc)}</td>
                  <td>{t.transfer_type === "storage" ? name(t.to_storage) : loc(t.to_loc)}</td>
                  <td><StatusBadge status={t.status} /></td><td>{dateTimeFmt(t.sent_at ?? t.created_at)}</td>
                </tr>
              ))}
              {!transfers?.length ? <tr><td colSpan={6} className="py-6 text-center text-muted">No transfers yet</td></tr> : null}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  );
}
