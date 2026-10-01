"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import { ExternalLink, HelpCircle, Minus, Plus } from "lucide-react";
import { Badge, Button, Notice, buttonClass, cx, inputBase } from "@/components/ui";
import { Modal, useToast } from "@/components/client";
import { CopyTextButton } from "@/components/copy-text";
import { money, qty } from "@/lib/format";
import { buildOrderList } from "@/lib/order-list";
import { Explanation } from "../../purchasing/order-builder";
import type { SuggestionRow } from "../../purchasing/load-suggestions";
import { markOrdered } from "../actions";

type Props = {
  vendor: { id: string; name: string; website: string | null; account: string | null; minimum: number };
  store: string; deliveryDate: string | null; nextDeliveryDate: string | null; rows: SuggestionRow[]; showCost: boolean; canOrder: boolean;
};

const n = (v: unknown) => new Decimal(String(v ?? 0) || 0);
const isQty = (s: string) => s === "" || /^\d+(\.\d{0,4})?$/.test(s);

export function VendorOrder(p: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [clientKey] = useState(() => crypto.randomUUID());
  const [qtys, setQtys] = useState<Record<string, string>>(() =>
    Object.fromEntries(p.rows.map((r) => [r.vendor_product_id, Number(r.suggested_qty) > 0 ? String(Number(r.suggested_qty)) : ""])));
  const [all, setAll] = useState(false);
  const [why, setWhy] = useState<SuggestionRow | null>(null);
  const [confirm, setConfirm] = useState(false);

  const visible = p.rows.filter((r) => all || Number(r.suggested_qty) > 0 || Number(qtys[r.vendor_product_id] || 0) > 0);
  const ordered = p.rows.filter((r) => Number(qtys[r.vendor_product_id] || 0) > 0);
  const total = useMemo(() => p.rows.reduce((s, r) => s.plus(n(qtys[r.vendor_product_id]).times(n(r.unit_price))), new Decimal(0)), [qtys, p.rows]);
  const overrides = p.rows.filter((r) => n(qtys[r.vendor_product_id]).cmp(n(r.suggested_qty)) !== 0).length;
  const deliveryLabel = p.deliveryDate ? new Date(`${p.deliveryDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : undefined;

  const listText = () => buildOrderList({
    vendor: p.vendor.name, store: p.store, deliveryLabel, account: p.vendor.account,
    lines: ordered.map((r) => ({ name: r.product_name, qty: qtys[r.vendor_product_id], unit: r.purchase_unit, itemNumber: r.vendor_item_number })),
  });
  const setQ = (id: string, v: string) => { if (isQty(v)) setQtys((q) => ({ ...q, [id]: v })); };
  const bump = (id: string, d: number) => setQtys((q) => ({ ...q, [id]: Decimal.max(0, n(q[id]).plus(d)).toString() }));

  function submit() {
    if (!p.deliveryDate) return;
    start(async () => {
      const res = await markOrdered({
        vendorId: p.vendor.id, deliveryDate: p.deliveryDate!, nextDeliveryDate: p.nextDeliveryDate, clientKey,
        lines: p.rows.map((r) => ({ product_id: r.product_id, vendor_product_id: r.vendor_product_id, unit_id: r.purchase_unit_id,
          order_qty: qtys[r.vendor_product_id] || "0", suggested_qty: String(r.suggested_qty), suggestion: r.explanation })),
      });
      setConfirm(false);
      if (res?.ok) { toast({ tone: "success", text: res.message ?? "Marked as ordered" }); router.push("/ordering"); router.refresh(); }
      else toast({ tone: "error", text: res?.error ?? "Could not save" });
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="inline-flex items-center gap-2"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Show the full order guide</label>
        <span className="ml-auto text-muted">{overrides} change{overrides === 1 ? "" : "s"} from the system suggestion</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface" data-testid="vendor-order-lines">
        {visible.map((r) => {
          const q = qtys[r.vendor_product_id] ?? "";
          const changed = n(q).cmp(n(r.suggested_qty)) !== 0;
          return (
            <div key={r.vendor_product_id} className={cx("grid gap-2 border-b border-border px-3 py-3 text-sm sm:grid-cols-[1fr_auto] sm:items-center", Number(q) > 0 && "bg-brand-soft/40")}>
              <div className="min-w-0">
                <div className="font-medium">{r.product_name} {!r.is_primary_vendor ? <Badge>Secondary vendor</Badge> : null}</div>
                <div className="text-xs text-muted">#{r.vendor_item_number} · {r.pack_size ?? ""} · 1 {r.purchase_unit} = {Number(r.unit_factor)} {r.inventory_unit}
                  {p.showCost ? ` · ${money(r.unit_price)}/${r.purchase_unit}` : ""}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span>On hand <b className="tabular-nums">{qty(r.on_hand, r.inventory_unit)}</b></span>
                  <span>Incoming <b className="tabular-nums">{qty(r.on_order, r.inventory_unit)}</b></span>
                  <span>System suggests <b className="tabular-nums">{Number(r.suggested_qty)} {r.purchase_unit}</b></span>
                  <button type="button" onClick={() => setWhy(r)} className="inline-flex items-center gap-1 font-semibold text-brand" aria-label={`Why ${Number(r.suggested_qty)} ${r.purchase_unit} of ${r.product_name}?`}>
                    <HelpCircle className="h-3.5 w-3.5" /> WHY?
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-1 sm:justify-end">
                <button type="button" aria-label={`Less ${r.product_name}`} onClick={() => bump(r.vendor_product_id, -1)} className="grid h-11 w-11 place-items-center rounded-md border border-border-strong"><Minus className="h-4 w-4" /></button>
                <input inputMode="decimal" value={q} onChange={(e) => setQ(r.vendor_product_id, e.target.value.trim())} aria-label={`Order quantity ${r.product_name}`}
                  className={cx(inputBase, "h-11 w-20 text-center text-base font-semibold tabular-nums", changed && "border-warning")} placeholder="0" />
                <button type="button" aria-label={`More ${r.product_name}`} onClick={() => bump(r.vendor_product_id, 1)} className="grid h-11 w-11 place-items-center rounded-md border border-border-strong"><Plus className="h-4 w-4" /></button>
                <span className="w-12 text-xs text-muted">{r.purchase_unit}</span>
              </div>
            </div>
          );
        })}
        {!visible.length ? <div className="p-8 text-center text-sm text-muted">Nothing needs ordering for this delivery. Tick “Show the full order guide” to add items anyway.</div> : null}
      </div>

      <div className="sticky bottom-16 z-10 rounded-lg border border-border bg-surface/95 p-3 backdrop-blur lg:bottom-2">
        <div className="mb-2 text-sm"><b>{ordered.length}</b> items{p.showCost ? <> · <b className="tabular-nums">{money(total.toNumber())}</b></> : null}
          {p.showCost && ordered.length && total.lt(p.vendor.minimum) ? <span className="ml-2 text-xs text-warning">below the {money(p.vendor.minimum)} minimum</span> : null}</div>
        <div className="grid gap-2 sm:grid-cols-3">
          <CopyTextButton text={listText} label="Copy order list" copiedMessage={`${p.vendor.name} order list copied (${ordered.length} items)`} testId="copy-order-list" />
          {p.vendor.website ? (
            <a href={p.vendor.website} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "md")} data-testid="open-vendor-website">
              <ExternalLink className="h-4 w-4" /> Open {p.vendor.name} website
            </a>
          ) : <span className="self-center text-center text-xs text-muted">No ordering website set for {p.vendor.name}</span>}
          {p.canOrder ? <Button variant="primary" onClick={() => setConfirm(true)} disabled={pending || !ordered.length || !p.deliveryDate}>Mark as ordered</Button> : null}
        </div>
      </div>

      <Modal open={!!why} onClose={() => setWhy(null)} title={why ? `Why ${Number(why.suggested_qty)} ${why.purchase_unit}? — ${why.product_name}` : ""}>
        {why ? <Explanation row={why} /> : null}
      </Modal>
      <Modal open={confirm} onClose={() => setConfirm(false)} title={`Did you place this order on the ${p.vendor.name} website?`}>
        <p className="text-sm">{ordered.length} items{p.showCost ? `, about ${money(total.toNumber())}` : ""}, for delivery {deliveryLabel ?? "—"}.</p>
        <Notice tone="info">This records the order here so it counts as incoming stock and the delivery can be checked against it. It does not send anything to {p.vendor.name}.</Notice>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirm(false)}>Not yet</Button>
          <Button variant="primary" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Yes, mark as ordered"}</Button>
        </div>
      </Modal>
    </div>
  );
}
