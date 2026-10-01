import Link from "next/link";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui";
import { dateFmt } from "@/lib/format";
import { CommissaryStatus, statusLabel } from "./status";

export const metadata = { title: "Commissary" };

type Order = { id: string; order_number: string; status: string; needed_date: string; location_id: string; commissary_location_id: string;
  discrepancy_value: number | null; restaurant_code: string; restaurant_name: string; commissary_code: string; commissary_name: string };

export default async function CommissaryPage() {
  const ctx = await requirePermission("orders.view");
  const supabase = await createClient();
  const [{ data: loc }, { data: orders }] = await Promise.all([
    supabase.from("locations").select("kind").eq("id", ctx.location.id).single(),
    supabase.rpc("list_commissary_orders", { p_location: ctx.location.id }),
  ]);
  const list = (orders ?? []) as Order[];
  const isCommissary = loc?.kind === "commissary";

  if (isCommissary) {
    const toDo = list.filter((o) => o.commissary_location_id === ctx.location.id && ["submitted", "accepted", "preparing", "ready"].includes(o.status))
      .sort((a, b) => a.needed_date.localeCompare(b.needed_date));
    const out = list.filter((o) => o.commissary_location_id === ctx.location.id && o.status === "in_transit");
    return (
      <>
        <PageHeader title="Commissary orders to fill" subtitle={`${ctx.location.name}: accept, prepare, mark ready and ship. Restaurants confirm what arrives.`} />
        <div className="grid gap-4 lg:grid-cols-2">
          <OrderList title="To prepare" orders={toDo} who="restaurant" empty="No orders waiting." />
          <OrderList title="On the way" orders={out} who="restaurant" empty="Nothing in transit." />
        </div>
        <History orders={list.filter((o) => ["received", "cancelled"].includes(o.status))} who="restaurant" />
      </>
    );
  }

  const mine = list.filter((o) => o.location_id === ctx.location.id);
  const incoming = mine.filter((o) => o.status === "in_transit");
  const open = mine.filter((o) => ["draft", "submitted", "accepted", "preparing", "ready"].includes(o.status));
  return (
    <>
      <PageHeader title="Commissary" subtitle="Order from the central kitchen, track it, and confirm what arrives."
        actions={can(ctx, "orders.create") ? <LinkButton href="/commissary/new" variant="primary">New commissary order</LinkButton> : null} />
      <div className="grid gap-4 lg:grid-cols-2">
        <OrderList title="Arriving — receive these" orders={incoming} who="commissary" empty="No commissary deliveries on the way." receive={can(ctx, "orders.receive")} />
        <OrderList title="Open orders" orders={open} who="commissary" empty="No open commissary orders." />
      </div>
      <History orders={mine.filter((o) => ["received", "cancelled"].includes(o.status))} who="commissary" />
    </>
  );
}

function OrderList({ title, orders, who, empty, receive }: { title: string; orders: Order[]; who: "restaurant" | "commissary"; empty: string; receive?: boolean }) {
  return (
    <Card title={title} padded={false}>
      {orders.length ? (
        <ul className="divide-y divide-border">
          {orders.map((o) => (
            <li key={o.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">{o.order_number} <span className="text-sm text-muted">· {who === "restaurant" ? `#${o.restaurant_code} ${o.restaurant_name}` : o.commissary_name}</span></div>
                <div className="text-xs text-muted">Needed {dateFmt(o.needed_date)} · <CommissaryStatus status={o.status} /></div>
              </div>
              <Link href={`/commissary/${o.id}`} className="shrink-0 text-sm font-medium text-brand">{receive && o.status === "in_transit" ? "Receive →" : "Open →"}</Link>
            </li>
          ))}
        </ul>
      ) : <div className="p-4"><EmptyState title={empty} /></div>}
    </Card>
  );
}

function History({ orders, who }: { orders: Order[]; who: "restaurant" | "commissary" }) {
  if (!orders.length) return null;
  return (
    <Card title="History" padded={false} className="mt-4">
      <table className="tbl">
        <thead><tr><th>Order</th><th>{who === "restaurant" ? "Restaurant" : "From"}</th><th>Needed</th><th>Status</th><th>Differences</th></tr></thead>
        <tbody>{orders.map((o) => (
          <tr key={o.id}><td><Link className="text-brand" href={`/commissary/${o.id}`}>{o.order_number}</Link></td>
            <td>{who === "restaurant" ? `#${o.restaurant_code}` : o.commissary_name}</td><td>{dateFmt(o.needed_date)}</td>
            <td>{statusLabel(o.status)}</td><td>{o.discrepancy_value !== null ? <Badge tone="warning">FLAGGED</Badge> : "—"}</td></tr>
        ))}</tbody>
      </table>
    </Card>
  );
}
