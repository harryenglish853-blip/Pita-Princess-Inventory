import Link from "next/link";
import Decimal from "decimal.js";
import { ExternalLink } from "lucide-react";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, EmptyState, LinkButton, Notice, PageHeader, buttonClass } from "@/components/ui";
import { CopyTextButton } from "@/components/copy-text";
import { money } from "@/lib/format";
import { buildOrderList } from "@/lib/order-list";
import type { SuggestionRow } from "../purchasing/load-suggestions";
import { deadlineLabel, deliveryLabel, loadSchedule, safeWebsite, timeLeft, type VendorSchedule } from "./schedule";

export const metadata = { title: "Ordering center" };

export default async function OrderingCenter() {
  const ctx = await requirePermission("orders.create");
  const supabase = await createClient();
  const { vendors, error } = await loadSchedule(ctx.location.id);
  // dynamic pars follow the latest forecast before anything is suggested
  await supabase.rpc("refresh_dynamic_pars", { p_location: ctx.location.id });
  const distributors = vendors.filter((v) => v.kind !== "commissary");
  const commissary = vendors.filter((v) => v.kind === "commissary");
  const suggestions = await Promise.all(distributors.map(async (v) => {
    if (!v.delivery_date) return { rows: [] as SuggestionRow[], error: "No delivery days set for this vendor" };
    const { data, error } = await supabase.rpc("suggest_order", {
      p_location: ctx.location.id, p_vendor: v.vendor_id, p_delivery_date: v.delivery_date, p_next_delivery_date: v.next_delivery_date, p_exclude_po: null,
    });
    return { rows: ((data ?? []) as SuggestionRow[]).filter((r) => Number(r.suggested_qty) > 0), error: error?.message ?? null };
  }));
  const showCost = can(ctx, "reports.view_cost");
  const store = `#${ctx.location.code} ${ctx.location.name}`;
  return (
    <>
      <PageHeader title="Ordering center" subtitle="What to order from each vendor before its cutoff. Place the order on the vendor's website, then mark it as ordered." />
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {!distributors.length && !commissary.length ? (
        <EmptyState title="No vendors yet" action={can(ctx, "orders.view") ? <LinkButton href="/vendors" variant="primary">Vendors</LinkButton> : null}>
          Add your vendors with their delivery days, cutoff and ordering website.
        </EmptyState>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {distributors.map((v, i) => (
          <VendorCard key={v.vendor_id} v={v} rows={suggestions[i].rows} error={suggestions[i].error} showCost={showCost} store={store} tz={ctx.location.timezone} />
        ))}
        {commissary.map((v) => (
          <Card key={v.vendor_id} title={<span className="text-base uppercase tracking-wide">{v.vendor_name}</span>}>
            <p className="text-sm text-muted">Internal supplier and central kitchen. Orders are placed, prepared, sent and received inside this app.</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <LinkButton href="/commissary/new" variant="primary">New commissary order</LinkButton>
              <LinkButton href="/commissary">Commissary orders</LinkButton>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

function VendorCard({ v, rows, error, showCost, store, tz }: { v: VendorSchedule; rows: SuggestionRow[]; error: string | null; showCost: boolean; store: string; tz: string }) {
  const total = rows.reduce((s, r) => s.plus(new Decimal(String(r.suggested_qty)).times(String(r.unit_price))), new Decimal(0));
  const site = safeWebsite(v.order_website);
  const list = buildOrderList({
    vendor: v.vendor_name, store, deliveryLabel: deliveryLabel(v.delivery_date), account: v.account_number,
    lines: rows.map((r) => ({ name: r.product_name, qty: r.suggested_qty, unit: r.purchase_unit, itemNumber: r.vendor_item_number })),
  });
  const left = timeLeft(v.order_by);
  return (
    <Card title={<span className="text-base uppercase tracking-wide">{v.vendor_name}</span>}
      actions={v.ordered_po_id ? <Badge tone="success">ORDERED · {v.ordered_po_number}</Badge> : left === "cutoff passed" ? <Badge tone="danger">CUTOFF PASSED</Badge> : null}>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm" data-testid={`vendor-card-${v.vendor_name}`}>
        <div><dt className="text-xs text-muted">Next delivery</dt><dd className="font-semibold">{deliveryLabel(v.delivery_date)}</dd></div>
        <div><dt className="text-xs text-muted">Order cutoff</dt><dd className="font-semibold">{deadlineLabel(v.order_by, tz)}</dd>
          {left ? <dd className={`text-xs ${left === "cutoff passed" ? "text-danger" : "text-muted"}`}>{left}</dd> : null}</div>
        <div><dt className="text-xs text-muted">Suggested items</dt><dd className="text-lg font-semibold tabular-nums">{rows.length}</dd></div>
        {showCost ? <div><dt className="text-xs text-muted">Estimated order</dt><dd className="text-lg font-semibold tabular-nums">{money(total.toNumber())}</dd>
          {Number(v.minimum_order) > 0 && total.lt(v.minimum_order) && rows.length ? <dd className="text-xs text-warning">Below {money(v.minimum_order)} minimum</dd> : null}</div> : null}
      </dl>
      {error ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
      <div className="mt-4 grid gap-2">
        <LinkButton href={`/ordering/${v.vendor_id}`} variant="primary">View suggested order</LinkButton>
        <CopyTextButton text={list} label="Copy order list" copiedMessage={`${v.vendor_name} order list copied (${rows.length} items)`} testId={`copy-${v.vendor_name}`} />
        {site ? (
          <a href={site} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "md")} data-testid={`open-${v.vendor_name}`}>
            <ExternalLink className="h-4 w-4" /> Open {v.vendor_name} website
          </a>
        ) : (
          <p className="rounded-md border border-dashed border-border-strong px-3 py-2 text-center text-xs text-muted">
            No ordering website set. <Link href={`/vendors/${v.vendor_id}`} className="text-brand">Add it on the vendor</Link>
          </p>
        )}
      </div>
    </Card>
  );
}
