"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import { HelpCircle, Minus, Plus } from "lucide-react";
import { Badge, Button, Card, Field, Input, Notice, cx, inputBase } from "@/components/ui";
import { Modal, useToast } from "@/components/client";
import { money, qty, dateFmt } from "@/lib/format";
import { saveOrder } from "./actions";
import type { SuggestionRow } from "./load-suggestions";

type Props = {
  poId: string | null; vendor: { id: string; name: string; minimum_order: number; order_cutoff: string | null; lead_time_days: number };
  deliveryDate: string; nextDeliveryDate: string | null; rows: SuggestionRow[]; initialQty?: Record<string, string>;
  initialNotes?: string | null; showCost: boolean; canSubmit: boolean; error?: string | null;
};

const n = (v: unknown) => new Decimal(String(v ?? 0) || 0);

export function OrderBuilder(p: Props) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [clientKey] = useState(() => crypto.randomUUID());
  const [delivery, setDelivery] = useState(p.deliveryDate);
  const [next, setNext] = useState(p.nextDeliveryDate ?? (p.rows[0]?.explanation?.next_delivery_date as string) ?? "");
  const [notes, setNotes] = useState(p.initialNotes ?? "");
  const [qtys, setQtys] = useState<Record<string, string>>(() => {
    const o: Record<string, string> = {};
    for (const r of p.rows) o[r.vendor_product_id] = p.initialQty?.[r.vendor_product_id] ?? (Number(r.suggested_qty) > 0 ? String(Number(r.suggested_qty)) : "");
    return o;
  });
  const [onlyNeeded, setOnlyNeeded] = useState(false);
  const [search, setSearch] = useState("");
  const [why, setWhy] = useState<SuggestionRow | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [dirty, setDirty] = useState(false);

  const visible = p.rows.filter((r) => {
    if (onlyNeeded && !(Number(r.suggested_qty) > 0 || Number(qtys[r.vendor_product_id] || 0) > 0)) return false;
    if (search && !`${r.product_name} ${r.vendor_item_number} ${r.product_number}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const total = useMemo(() => p.rows.reduce((s, r) => s.plus(n(qtys[r.vendor_product_id]).times(n(r.unit_price))), new Decimal(0)), [qtys, p.rows]);
  const lineCount = p.rows.filter((r) => Number(qtys[r.vendor_product_id] || 0) > 0).length;
  const overrides = p.rows.filter((r) => Number(qtys[r.vendor_product_id] || 0) !== Number(r.suggested_qty)).length;
  const belowMin = total.lt(p.vendor.minimum_order);

  const setQ = (id: string, v: string) => { setQtys((q) => ({ ...q, [id]: v })); setDirty(true); };
  const bump = (id: string, d: number) => setQ(id, String(Math.max(0, Number(qtys[id] || 0) + d)));

  function recalc() {
    if (dirty && !confirm("Recalculate suggestions for the new dates? Quantities you typed will be replaced.")) return;
    const u = new URLSearchParams({ vendor: p.vendor.id, delivery, ...(next ? { next } : {}) });
    router.push(p.poId ? `/purchasing/${p.poId}/edit?${u}` : `/purchasing/new?${u}`);
  }

  function save(submit: boolean) {
    start(async () => {
      const lines = p.rows.map((r) => ({
        product_id: r.product_id, vendor_product_id: r.vendor_product_id, unit_id: r.purchase_unit_id,
        order_qty: qtys[r.vendor_product_id] || "0", suggested_qty: String(r.suggested_qty), suggestion: r.explanation,
      })).filter((l) => Number(l.order_qty) > 0 || Number(l.suggested_qty) > 0);
      if (submit && !lines.some((l) => Number(l.order_qty) > 0)) { toast({ tone: "error", text: "Enter at least one quantity" }); return; }
      const res = await saveOrder({ poId: p.poId, vendorId: p.vendor.id, deliveryDate: delivery, nextDeliveryDate: next || null, notes: notes || null,
        deliveryWindow: null, lines, clientKey, submit, confirmBelowMinimum: submit });
      setConfirmSubmit(false);
      if (res?.ok) { toast({ tone: "success", text: res.message ?? "Saved" }); setDirty(false); router.push(`/purchasing/${res.data!.id}`); }
      else { toast({ tone: "error", text: res?.error ?? "Save failed" }); if (res?.data?.id) router.push(`/purchasing/${res.data.id}`); }
    });
  }

  return (
    <div className="space-y-4">
      {p.error ? <Notice tone="danger">{p.error}</Notice> : null}
      <Card>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div><div className="text-xs text-muted">Vendor</div><div className="font-semibold">{p.vendor.name}</div>
            <div className="text-xs text-muted">Cutoff {p.vendor.order_cutoff?.slice(0, 5) ?? "—"} · lead {p.vendor.lead_time_days}d · min {money(p.vendor.minimum_order)}</div></div>
          <Field label="Expected delivery"><Input type="date" value={delivery} onChange={(e) => setDelivery(e.target.value)} /></Field>
          <Field label="Covers until (next delivery)"><Input type="date" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <div className="flex items-end"><Button onClick={recalc} disabled={pending}>Recalculate</Button></div>
          <div className="text-xs text-muted lg:text-right">
            Consumption days: <b>{next && delivery ? Math.round((new Date(next).getTime() - new Date(delivery).getTime()) / 86400000) : "—"}</b><br />
            Suggestions = forecast usage through the next delivery + safety stock (or par) − on hand − incoming, rounded up to purchase units.
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <input type="search" placeholder="Search order guide…" value={search} onChange={(e) => setSearch(e.target.value)} className={cx(inputBase, "h-9 w-full sm:w-64")} aria-label="Search order guide" />
        <label className="inline-flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyNeeded} onChange={(e) => setOnlyNeeded(e.target.checked)} /> Only items to order</label>
        <span className="ml-auto text-sm text-muted">{overrides} manager change{overrides === 1 ? "" : "s"} vs system suggestion</span>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="hidden grid-cols-[minmax(12rem,2fr)_repeat(4,minmax(4.5rem,1fr))_minmax(6rem,1fr)_minmax(9rem,1.3fr)_minmax(5rem,1fr)_minmax(5.5rem,1fr)] gap-2 border-b border-border bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase text-muted lg:grid">
          <span>Product</span><span className="text-right">On hand</span><span className="text-right">In transit</span><span className="text-right">Forecast use</span><span className="text-right">Par</span>
          <span className="text-right">Suggested</span><span className="text-center">Order qty</span><span className="text-right">Cost</span><span className="text-right">Extended</span>
        </div>
        {visible.map((r) => {
          const q = qtys[r.vendor_product_id] ?? "";
          const changed = Number(q || 0) !== Number(r.suggested_qty);
          const ext = n(q).times(n(r.unit_price));
          return (
            <div key={r.vendor_product_id} className={cx("grid grid-cols-2 gap-2 border-b border-border px-3 py-2 text-sm lg:grid-cols-[minmax(12rem,2fr)_repeat(4,minmax(4.5rem,1fr))_minmax(6rem,1fr)_minmax(9rem,1.3fr)_minmax(5rem,1fr)_minmax(5.5rem,1fr)] lg:items-center", Number(q) > 0 && "bg-brand-soft/40")}>
              <div className="col-span-2 lg:col-span-1">
                <div className="font-medium">{r.product_name} {!r.is_primary_vendor ? <Badge>Secondary vendor</Badge> : null}{r.explanation?.negative_on_hand ? <Badge tone="danger">Negative on hand</Badge> : null}</div>
                <div className="text-[11px] text-muted">#{r.vendor_item_number} · {r.pack_size ?? ""} · {r.purchase_unit} = {Number(r.unit_factor)} {r.inventory_unit}</div>
              </div>
              <Cell label="On hand" value={qty(r.on_hand, r.inventory_unit)} danger={Number(r.on_hand) < 0} />
              <Cell label="In transit" value={qty(r.on_order, r.inventory_unit)} />
              <Cell label="Forecast use" value={qty(r.forecast_usage, r.inventory_unit)} />
              <Cell label="Par" value={r.par === null ? "—" : qty(r.par, r.inventory_unit)} />
              <div className="flex items-center justify-end gap-1">
                <span className="text-[11px] text-muted lg:hidden">Suggested</span>
                <span className="font-semibold tabular-nums">{Number(r.suggested_qty)} {r.purchase_unit}</span>
                <button type="button" onClick={() => setWhy(r)} className="rounded p-0.5 text-brand hover:bg-brand-soft" aria-label={`Why ${Number(r.suggested_qty)} ${r.purchase_unit}?`} title="Why?"><HelpCircle className="h-4 w-4" /></button>
              </div>
              <div className="col-span-2 flex items-center justify-center gap-1 lg:col-span-1">
                <button type="button" aria-label="Decrease" disabled={!p.canSubmit && false} onClick={() => bump(r.vendor_product_id, -1)} className="grid h-9 w-9 place-items-center rounded-md border border-border-strong"><Minus className="h-4 w-4" /></button>
                <input inputMode="decimal" value={q} onChange={(e) => setQ(r.vendor_product_id, e.target.value.replace(/[^0-9.]/g, ""))} aria-label={`Order quantity ${r.product_name}`}
                  className={cx(inputBase, "h-9 w-16 text-center font-semibold tabular-nums", changed && "border-warning")} placeholder="0" />
                <button type="button" aria-label="Increase" onClick={() => bump(r.vendor_product_id, 1)} className="grid h-9 w-9 place-items-center rounded-md border border-border-strong"><Plus className="h-4 w-4" /></button>
              </div>
              <Cell label="Cost" value={p.showCost ? `${money(r.unit_price)}/${r.purchase_unit}` : "—"} />
              <Cell label="Extended" value={p.showCost ? money(ext.toNumber()) : "—"} strong />
            </div>
          );
        })}
        {!visible.length ? <div className="p-8 text-center text-sm text-muted">No order guide items{onlyNeeded ? " need ordering" : ""}.</div> : null}
      </div>

      <Field label="Notes to vendor"><Input value={notes} onChange={(e) => { setNotes(e.target.value); setDirty(true); }} placeholder="Delivery instructions…" /></Field>

      <div className="sticky bottom-16 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface/95 p-3 backdrop-blur lg:bottom-2">
        <div className="text-sm">
          <div><b>{lineCount}</b> items · {p.showCost ? <b className="tabular-nums">{money(total.toNumber())}</b> : null}</div>
          {belowMin && lineCount ? <div className="text-xs text-warning">Below the {money(p.vendor.minimum_order)} vendor minimum</div> : null}
        </div>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => save(false)} disabled={pending}>{pending ? "Saving…" : "Save draft"}</Button>
          {p.canSubmit ? <Button variant="primary" onClick={() => setConfirmSubmit(true)} disabled={pending || !lineCount}>Submit order</Button> : null}
        </div>
      </div>

      <Modal open={!!why} onClose={() => setWhy(null)} title={why ? `Why ${Number(why.suggested_qty)} ${why.purchase_unit}? — ${why.product_name}` : ""}>
        {why ? <Explanation row={why} /> : null}
      </Modal>
      <Modal open={confirmSubmit} onClose={() => setConfirmSubmit(false)} title={`Submit order to ${p.vendor.name}?`}>
        <p className="text-sm">{lineCount} items{p.showCost ? `, total ${money(total.toNumber())}` : ""}, delivery {dateFmt(delivery)}.</p>
        {belowMin ? <p className="mt-2 text-sm text-warning">This is below the vendor minimum of {money(p.vendor.minimum_order)}. Freight charges may apply.</p> : null}
        <p className="mt-2 text-xs text-muted">Once submitted the order is locked. The system suggestion and your quantities are both kept for ordering analysis.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setConfirmSubmit(false)}>Back</Button>
          <Button variant="primary" onClick={() => save(true)} disabled={pending}>{pending ? "Submitting…" : "Submit order"}</Button>
        </div>
      </Modal>
    </div>
  );
}

function Cell({ label, value, danger, strong }: { label: string; value: string; danger?: boolean; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-2 lg:block lg:text-right">
      <span className="text-[11px] text-muted lg:hidden">{label}</span>
      <span className={cx("tabular-nums", danger && "text-danger", strong && "font-semibold")}>{value}</span>
    </div>
  );
}

export function Explanation({ row }: { row: SuggestionRow }) {
  const e = row.explanation as Record<string, number | string | boolean | null>;
  const u = row.inventory_unit;
  const line = (label: string, v: React.ReactNode, b?: boolean) => (
    <div className={cx("flex justify-between border-b border-border py-1.5 text-sm", b && "font-semibold")}><span>{label}</span><span className="tabular-nums">{v}</span></div>
  );
  return (
    <div>
      {line(`Expected usage until delivery (${e.days_until_delivery} days)`, qty(e.usage_until_delivery as number, u))}
      {line(`Expected usage until next delivery (${e.coverage_days} days × ${qty(e.avg_daily_usage as number)} / day)`, qty(e.usage_during_coverage as number, u))}
      {line("Safety stock", qty(e.safety_stock as number, u))}
      {e.par !== null && e.par_mode !== "none" ? line(`${e.par_mode === "dynamic" ? "Dynamic" : "Static"} par (used if higher than usage + safety)`, qty(e.par as number, u)) : null}
      {line("NEED", qty(e.need as number, u), true)}
      {line(`On hand${e.negative_on_hand ? " (negative — counted as 0)" : ""}`, qty(e.on_hand as number, u))}
      {line("Incoming (open orders)", qty(e.incoming as number, u))}
      {line("HAVE", qty(e.have as number, u), true)}
      {line("Shortage (need − have)", qty(e.shortage as number, u), true)}
      {line(`${row.purchase_unit} size`, `${Number(row.unit_factor)} ${u}`)}
      {line(`Shortage in ${row.purchase_unit}`, `${qty(e.raw_purchase_units as number)} → round up${Number(e.order_multiple) !== 1 ? ` to multiple of ${e.order_multiple}` : ""}${Number(e.min_order_qty) > 0 ? `, min ${e.min_order_qty}` : ""}`)}
      {line("Recommended", `${Number(row.suggested_qty)} ${row.purchase_unit}`, true)}
      <p className="mt-3 text-xs text-muted">Usage method: {String(e.forecast_method)}. {e.is_primary_vendor ? "" : "This vendor is not the primary vendor for this item, so nothing is suggested here."}</p>
    </div>
  );
}
