import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, EmptyState, Field, Input, Notice, PageHeader, Stat, TabLinks } from "@/components/ui";
import { dateTimeFmt, qty } from "@/lib/format";
import { MapItem } from "../[id]/map-item";
import { reprocessToast, setToastRestaurant, uploadToastOrders } from "../actions";

export const metadata = { title: "Toast" };

type Status = { restaurant_guid: string | null; last_event_at: string | null; last_applied_at: string | null; orders_today: number; errors_24h: number;
  unmapped: { item_guid: string | null; item_name: string; qty: number }[] };

export default async function ToastPage() {
  const ctx = await requirePermission("sales.import");
  const supabase = await createClient();
  const [{ data: st }, { data: log }, { data: recipes }] = await Promise.all([
    supabase.rpc("toast_sync_status", { p_location: ctx.location.id }),
    supabase.from("toast_sync_log").select("id, created_at, source, toast_guid, business_date, status, message").eq("location_id", ctx.location.id).order("id", { ascending: false }).limit(100),
    supabase.from("recipes").select("id, name").eq("active", true).order("name"),
  ]);
  const s = (st ?? { unmapped: [] }) as Status;
  const webhookReady = !!process.env.TOAST_WEBHOOK_SECRET;
  return (
    <>
      <PageHeader title="Toast" subtitle="Order-level sync: each Toast order is applied once; updates, voids and refunds post only the difference." />
      <TabLinks active="toast" tabs={[{ key: "imports", label: "Daily sales", href: "/sales" }, { key: "toast", label: "Toast sync", href: "/sales/toast" }]} />
      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Orders synced today" value={s.orders_today ?? 0} />
        <Stat label="Last order received" value={s.last_applied_at ? dateTimeFmt(s.last_applied_at, ctx.location.timezone) : "Never"} />
        <Stat label="Errors / held (24 h)" value={s.errors_24h ?? 0} tone={s.errors_24h ? "danger" : undefined} />
        <Stat label="Unmapped Toast items" value={s.unmapped?.length ?? 0} tone={s.unmapped?.length ? "warning" : undefined} />
      </div>
      {!webhookReady ? <div className="mb-4"><Notice tone="warning" title="BLOCKED — REQUIRES EXTERNAL CONFIGURATION">
        Live sync needs Toast partner API access: register the webhook <code>/api/toast/webhook</code> in Toast and set TOAST_WEBHOOK_SECRET. Until then, upload Toast order exports below or keep importing the daily sales file.</Notice></div> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="UNMAPPED TOAST ITEMS">
          {s.unmapped?.length ? (
            <ul className="divide-y divide-border">{s.unmapped.map((u) => (
              <li key={`${u.item_guid}-${u.item_name}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div><div className="font-medium">{u.item_name}</div><div className="text-xs text-muted">{qty(u.qty)} sold · not depleting inventory</div></div>
                {canOrg(ctx, "recipes.edit") ? <MapItem posItemId={u.item_guid} itemName={u.item_name} recipes={recipes ?? []} /> : <Badge tone="warning">Ask an owner to map</Badge>}
              </li>))}</ul>
          ) : <EmptyState title="Every Toast item is mapped to a recipe" />}
        </Card>
        <Card title="Connection">
          {can(ctx, "settings.manage") ? (
            <ActionForm action={setToastRestaurant} className="space-y-2">
              <Field label="Toast restaurant GUID for this store" hint="From Toast Web: Restaurant info. Webhook events for this GUID go to this store.">
                <Input name="restaurant_guid" defaultValue={s.restaurant_guid ?? ""} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
              </Field>
              <SubmitButton>Save</SubmitButton>
            </ActionForm>
          ) : <p className="text-sm">Toast restaurant: {s.restaurant_guid ?? "not set"}</p>}
          <ActionForm action={uploadToastOrders} className="mt-4 space-y-2 border-t border-border pt-4">
            <Field label="Upload Toast orders (JSON from the Orders API)"><Input type="file" name="file" accept="application/json,.json" /></Field>
            <SubmitButton variant="secondary">Process orders</SubmitButton>
          </ActionForm>
          <div className="mt-3"><ActionButton size="sm" variant="ghost" action={reprocessToast}>Reprocess unmapped orders</ActionButton></div>
        </Card>
      </div>

      <Card title="Sync log" padded={false} className="mt-4">
        {log?.length ? (
          <div className="overflow-x-auto"><table className="tbl">
            <thead><tr><th>When</th><th>Source</th><th>Order</th><th>Business date</th><th>Result</th><th>Details</th></tr></thead>
            <tbody>{log.map((l) => (
              <tr key={l.id}><td className="whitespace-nowrap">{dateTimeFmt(l.created_at, ctx.location.timezone)}</td><td>{l.source}</td>
                <td className="font-mono text-xs">{l.toast_guid ? l.toast_guid.slice(0, 13) : "—"}</td><td>{l.business_date ?? "—"}</td>
                <td><Badge tone={l.status === "applied" ? "success" : l.status === "error" ? "danger" : l.status === "held" ? "warning" : "neutral"}>{l.status.toUpperCase()}</Badge></td>
                <td className="max-w-md text-xs">{l.message}</td></tr>
            ))}</tbody>
          </table></div>
        ) : <div className="p-4"><EmptyState title="No Toast events yet" /></div>}
      </Card>
    </>
  );
}
