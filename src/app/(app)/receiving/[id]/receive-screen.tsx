"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import { AlertTriangle, ChevronDown, ChevronUp, Thermometer } from "lucide-react";
import { Badge, Button, Card, Field, Input, Notice, Select, cx, inputBase } from "@/components/ui";
import { Modal, useToast } from "@/components/client";
import { money, qty } from "@/lib/format";
import { cancelReceipt, completeReceiving, postReceipt, saveReceipt, type ReceiptTotals } from "../actions";
import { InvoiceScanner, type ScanApply } from "./invoice-scanner";

export type RLine = {
  id: string; product_id: string; product_name: string; product_number: string; inventory_unit: string; unit_code: string; unit_factor: number;
  line_type: string; substitute_for_id: string | null; po_item_id: string | null; vendor_item_number: string | null;
  ordered_qty: number; received_qty: number | null; invoiced_qty: number | null; rejected_qty: number; damaged_qty: number;
  contract_price: number | null; invoice_price: number | null; invoice_extended: number | null; catch_weight_qty: number | null;
  back_order: boolean; exception_codes: string[]; temperature: number | null; temp_min: number | null; temp_max: number | null;
  temp_decision: string | null; lot_number: string | null; lot_tlc: string | null; lot_production_date: string | null;
  expiration_date: string | null; best_by_date: string | null; storage_allocations: { storage_location_id: string; qty: number }[];
  notes: string | null; catch_weight: boolean; lot_tracked: boolean; default_storage_id: string | null;
};
type Header = { delivery_date: string; invoice_number: string; invoice_date: string; invoice_total: string; tax: string; freight: string; fuel_surcharge: string; misc_fees: string; credits: string; notes: string };
type Product = { id: string; name: string; vendor_product_id: string | null; vendor_item_number: string | null };

const EXC_LABEL: Record<string, string> = {
  short: "Short delivery", over: "Over shipment", missing: "Missing", invoice_qty_mismatch: "Invoice ≠ received", price_variance: "Price ≠ contract",
  temp_out_of_range: "Temperature out of range", back_order: "Back order", rejected: "Rejected", damaged: "Damaged", substitution: "Substitution",
  forced_ship: "Forced ship", wrong_item: "Wrong item", catch_weight: "Catch weight",
};
const toS = (v: unknown) => (v === null || v === undefined ? "" : String(v));
const D = (v: unknown) => new Decimal(toS(v) || 0);

/** Mirror of the server's exception rules for instant feedback; the server recomputes on save. */
function exceptionsOf(l: RLine): string[] {
  const out: string[] = [];
  const rec = l.received_qty, inv = l.invoiced_qty;
  if (rec !== null && l.line_type === "ordered" && rec < l.ordered_qty) out.push("short");
  if (rec !== null && l.line_type === "ordered" && rec > l.ordered_qty) out.push("over");
  if (rec === 0 && l.ordered_qty > 0) out.push("missing");
  if (inv !== null && rec !== null && inv !== rec) out.push("invoice_qty_mismatch");
  if (l.contract_price !== null && l.invoice_price !== null && Number(l.invoice_price) !== Number(l.contract_price)) out.push("price_variance");
  if (l.temperature !== null && ((l.temp_max !== null && l.temperature > l.temp_max) || (l.temp_min !== null && l.temperature < l.temp_min))) out.push("temp_out_of_range");
  if (l.back_order) out.push("back_order");
  if (l.rejected_qty > 0) out.push("rejected");
  if (l.damaged_qty > 0) out.push("damaged");
  if (l.line_type === "substitution") out.push("substitution");
  if (l.line_type === "forced") out.push("forced_ship");
  if (l.line_type === "wrong_item") out.push("wrong_item");
  if (l.catch_weight_qty !== null) out.push("catch_weight");
  return out;
}

export function ReceiveScreen(p: {
  receiptId: string; status: string; vendorName: string; poNumber: string | null; initialHeader: Header; initialLines: RLine[]; initialTotals: ReceiptTotals;
  storages: { id: string; name: string }[]; products: Product[]; canReceive: boolean; canReconcile: boolean; canOverride: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [header, setHeader] = useState<Header>(p.initialHeader);
  const [lines, setLines] = useState<RLine[]>(p.initialLines);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [headerDirty, setHeaderDirty] = useState(false);
  const [totals, setTotals] = useState<ReceiptTotals>(p.initialTotals);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newLine, setNewLine] = useState({ product_id: "", line_type: "substitution", substitute_for_id: "" });
  const [postDialog, setPostDialog] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const locked = !["draft", "received"].includes(p.status) || !p.canReceive;

  // Received quantity goes to the item's primary storage area unless the user splits it.
  const withDefaultStorage = (l: RLine): RLine => {
    if (!l.default_storage_id || l.received_qty === null) return l;
    const a = l.storage_allocations;
    if (a.length === 0 || (a.length === 1 && a[0].storage_location_id === l.default_storage_id)) {
      return { ...l, storage_allocations: l.received_qty > 0 ? [{ storage_location_id: l.default_storage_id, qty: l.received_qty }] : [] };
    }
    return l;
  };
  const upd = (id: string, patch: Partial<RLine>) => {
    setLines((ls) => ls.map((l) => (l.id === id ? ("received_qty" in patch ? withDefaultStorage({ ...l, ...patch }) : { ...l, ...patch }) : l)));
    setChanged((c) => new Set(c).add(id));
  };
  const setH = (k: keyof Header, v: string) => { setHeader((h) => ({ ...h, [k]: v })); setHeaderDirty(true); };

  // Live financial preview (server recomputes authoritatively with receipt_totals)
  const live = useMemo(() => {
    const linesTotal = lines.reduce((s, l) => s.plus(l.invoice_extended !== null ? D(l.invoice_extended) : D(l.invoiced_qty).times(D(l.invoice_price))), new Decimal(0));
    const calc = linesTotal.plus(D(header.tax)).plus(D(header.freight)).plus(D(header.fuel_surcharge)).plus(D(header.misc_fees)).minus(D(header.credits));
    const inv = header.invoice_total === "" ? null : D(header.invoice_total);
    const shortageCredit = lines.reduce((s, l) => {
      const diff = D(l.invoiced_qty).minus(D(l.received_qty));
      return diff.gt(0) ? s.plus(diff.times(D(l.invoice_price ?? l.contract_price))) : s;
    }, new Decimal(0));
    return { linesTotal, calc, inv, overShort: inv ? inv.minus(calc) : null, shortageCredit };
  }, [lines, header]);
  const within = live.overShort !== null && live.overShort.abs().lte(totals.tolerance);

  function payload() {
    const h = headerDirty ? {
      delivery_date: header.delivery_date, invoice_number: header.invoice_number, invoice_date: header.invoice_date, invoice_total: header.invoice_total,
      tax: header.tax || "0", freight: header.freight || "0", fuel_surcharge: header.fuel_surcharge || "0", misc_fees: header.misc_fees || "0", credits: header.credits || "0", notes: header.notes,
    } : null;
    const ls = lines.filter((l) => changed.has(l.id)).map((l) => ({
      id: l.id, received_qty: toS(l.received_qty), invoiced_qty: toS(l.invoiced_qty), invoice_price: toS(l.invoice_price),
      invoice_extended: toS(l.invoice_extended), rejected_qty: toS(l.rejected_qty), damaged_qty: toS(l.damaged_qty),
      catch_weight_qty: toS(l.catch_weight_qty), back_order: l.back_order, temperature: toS(l.temperature), temp_decision: toS(l.temp_decision),
      lot_number: toS(l.lot_number), lot_tlc: toS(l.lot_tlc), lot_production_date: toS(l.lot_production_date), expiration_date: toS(l.expiration_date),
      best_by_date: toS(l.best_by_date), storage_allocations: l.storage_allocations, notes: toS(l.notes),
    }));
    return { h, ls };
  }

  async function persist(): Promise<boolean> {
    const { h, ls } = payload();
    if (!h && !ls.length) return true;
    const r = await saveReceipt(p.receiptId, h, ls);
    if (!r?.ok) { toast({ tone: "error", text: r?.error ?? "Save failed" }); return false; }
    setTotals(r.data!); setChanged(new Set()); setHeaderDirty(false);
    return true;
  }

  const run = (fn: () => Promise<void>) => start(fn);
  const save = () => run(async () => { if (await persist()) { toast({ tone: "success", text: "Saved" }); router.refresh(); } });
  const complete = () => run(async () => {
    if (!(await persist())) return;
    const r = await completeReceiving(p.receiptId);
    if (r?.ok) { toast({ tone: "success", text: r.message! }); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
  });
  const post = () => run(async () => {
    if (!(await persist())) return;
    const r = await postReceipt(p.receiptId, overrideReason);
    if (r?.ok) { setPostDialog(false); toast({ tone: "success", text: r.message! }); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
  });
  const receiveAll = () => {
    setLines((ls) => ls.map((l) => withDefaultStorage({ ...l, received_qty: l.received_qty ?? l.ordered_qty, invoiced_qty: l.invoiced_qty ?? l.ordered_qty })));
    setChanged(new Set(lines.map((l) => l.id)));
  };
  const addLine = () => run(async () => {
    if (!newLine.product_id) return;
    if (!(await persist())) return;
    const prod = p.products.find((x) => x.id === newLine.product_id);
    const r = await saveReceipt(p.receiptId, null, [{ product_id: newLine.product_id, vendor_product_id: prod?.vendor_product_id ?? "", line_type: newLine.line_type, substitute_for_id: newLine.substitute_for_id }]);
    if (r?.ok) { setAdding(false); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
  });

  function applyScan(a: ScanApply) {
    setHeader((h) => ({ ...h, ...Object.fromEntries(Object.entries(a.header).filter(([, v]) => v !== undefined)) }));
    setHeaderDirty(true);
    setLines((ls) => ls.map((l) => { const m = a.lines.find((x) => x.id === l.id); return m ? { ...l, invoiced_qty: m.invoiced_qty ?? l.invoiced_qty, invoice_price: m.invoice_price ?? l.invoice_price, invoice_extended: null } : l; }));
    setChanged((c) => { const n = new Set(c); a.lines.forEach((x) => n.add(x.id)); return n; });
    toast({ tone: "info", text: "Invoice values applied. Review them, then Save." });
  }

  const dirty = headerDirty || changed.size > 0;
  const tempProblems = lines.filter((l) => exceptionsOf(l).includes("temp_out_of_range") && !l.temp_decision);

  return (
    <div className="space-y-4">
      {p.status === "posted" ? <Notice tone="success" title="Reconciled and posted">Inventory, costs and price history were updated from this invoice. The receipt is locked.</Notice> : null}
      {p.status === "cancelled" ? <Notice tone="neutral" title="Cancelled" /> : null}

      <Card title="Invoice" actions={!locked ? <>
        <InvoiceScanner receiptId={p.receiptId} lines={lines.map((l) => ({ id: l.id, product_name: l.product_name, vendor_item_number: l.vendor_item_number, unit_code: l.unit_code }))} onApply={applyScan} />
        {p.status === "draft" ? <Button size="sm" onClick={receiveAll}>Everything arrived as ordered</Button> : null}
      </> : null}>
        <fieldset disabled={locked} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Delivery date"><Input type="date" value={header.delivery_date} onChange={(e) => setH("delivery_date", e.target.value)} /></Field>
          <Field label="Invoice #"><Input value={header.invoice_number} onChange={(e) => setH("invoice_number", e.target.value)} placeholder="From the vendor invoice" /></Field>
          <Field label="Invoice date"><Input type="date" value={header.invoice_date} onChange={(e) => setH("invoice_date", e.target.value)} /></Field>
          <Field label="Invoice total $"><Input inputMode="decimal" value={header.invoice_total} onChange={(e) => setH("invoice_total", e.target.value)} placeholder="0.00" /></Field>
          <Field label="Notes"><Input value={header.notes} onChange={(e) => setH("notes", e.target.value)} /></Field>
        </fieldset>
      </Card>

      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <div className="hidden grid-cols-[minmax(12rem,2fr)_5rem_7rem_7rem_7rem_6rem_minmax(8rem,1.2fr)_2rem] gap-2 border-b border-border bg-surface-2 px-3 py-2 text-[11px] font-semibold uppercase text-muted lg:grid">
          <span>Product</span><span className="text-right">Ordered</span><span className="text-center">Physically received</span><span className="text-center">Invoiced</span><span className="text-center">Invoice price</span><span className="text-right">Extended</span><span>Flags</span><span />
        </div>
        {lines.map((l) => {
          const exc = exceptionsOf(l);
          const ext = l.invoice_extended !== null ? D(l.invoice_extended) : D(l.invoiced_qty).times(D(l.invoice_price));
          const isOpen = open === l.id;
          return (
            <div key={l.id} className={cx("border-b border-border", exc.some((e) => ["short", "missing", "over", "temp_out_of_range", "invoice_qty_mismatch"].includes(e)) && "bg-warning-soft/60")}>
              <div className="grid grid-cols-2 items-center gap-2 px-3 py-2 text-sm lg:grid-cols-[minmax(12rem,2fr)_5rem_7rem_7rem_7rem_6rem_minmax(8rem,1.2fr)_2rem]">
                <div className="col-span-2 cursor-pointer lg:col-span-1" onClick={() => setOpen(isOpen ? null : l.id)}>
                  <div className="font-medium">{l.product_name}{l.line_type !== "ordered" ? <Badge tone="info" className="ml-1">{l.line_type.replace("_", " ")}</Badge> : null}</div>
                  <div className="text-[11px] text-muted">{l.vendor_item_number ?? "—"} · {l.unit_code} = {Number(l.unit_factor)} {l.inventory_unit}{l.contract_price !== null ? ` · contract ${money(l.contract_price)}` : ""}</div>
                </div>
                <div className="flex justify-between lg:block lg:text-right"><span className="text-[11px] text-muted lg:hidden">Ordered</span><span className="tabular-nums">{qty(l.ordered_qty, l.unit_code)}</span></div>
                <QtyInput label="Received" value={l.received_qty} disabled={locked} onChange={(v) => upd(l.id, { received_qty: v })} unit={l.unit_code} testId={`received-${l.product_number}`} />
                <QtyInput label="Invoiced" value={l.invoiced_qty} disabled={locked} onChange={(v) => upd(l.id, { invoiced_qty: v })} unit={l.unit_code} testId={`invoiced-${l.product_number}`} />
                <QtyInput label="Price" value={l.invoice_price} disabled={locked} onChange={(v) => upd(l.id, { invoice_price: v, invoice_extended: null })} prefix="$" />
                <div className="flex justify-between lg:block lg:text-right"><span className="text-[11px] text-muted lg:hidden">Extended</span><span className="font-semibold tabular-nums">{money(ext.toNumber())}</span></div>
                <div className="col-span-2 flex flex-wrap gap-1 lg:col-span-1" data-testid={`flags-${l.product_number}`}>
                  {exc.map((e) => <Badge key={e} tone={["short", "missing", "temp_out_of_range", "rejected", "wrong_item"].includes(e) ? "danger" : "warning"}>{EXC_LABEL[e] ?? e}</Badge>)}
                  {!exc.length && l.received_qty !== null ? <Badge tone="success">OK</Badge> : null}
                </div>
                <button type="button" onClick={() => setOpen(isOpen ? null : l.id)} aria-expanded={isOpen} aria-label={`Details for ${l.product_name}`} className="col-span-2 justify-self-end rounded p-1 text-muted hover:bg-surface-2 lg:col-span-1">
                  {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                </button>
              </div>
              {isOpen ? <LineDetails line={l} locked={locked} storages={p.storages} onChange={(patch) => upd(l.id, patch)} /> : null}
            </div>
          );
        })}
        {!lines.length ? <div className="p-6 text-center text-sm text-muted">No lines yet — add the delivered products below.</div> : null}
        {!locked ? (
          <div className="p-3">
            {adding ? (
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Product" className="min-w-56 flex-1">
                  <Select value={newLine.product_id} onChange={(e) => setNewLine((n) => ({ ...n, product_id: e.target.value }))}>
                    <option value="">Choose…</option>{p.products.map((x) => <option key={x.id} value={x.id}>{x.name}{x.vendor_item_number ? ` (${x.vendor_item_number})` : ""}</option>)}
                  </Select>
                </Field>
                <Field label="Type">
                  <Select value={newLine.line_type} onChange={(e) => setNewLine((n) => ({ ...n, line_type: e.target.value }))}>
                    <option value="substitution">Substitution</option><option value="forced">Forced shipped item</option><option value="wrong_item">Wrong item</option><option value="unordered">Not on order</option>
                  </Select>
                </Field>
                {newLine.line_type === "substitution" ? (
                  <Field label="Substitutes for"><Select value={newLine.substitute_for_id} onChange={(e) => setNewLine((n) => ({ ...n, substitute_for_id: e.target.value }))}>
                    <option value="">—</option>{lines.filter((l) => l.line_type === "ordered").map((l) => <option key={l.id} value={l.id}>{l.product_name}</option>)}
                  </Select></Field>
                ) : null}
                <Button variant="primary" onClick={addLine} disabled={pending || !newLine.product_id}>Add line</Button>
                <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              </div>
            ) : <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>+ Add substitution / extra item</Button>}
          </div>
        ) : null}
      </div>

      <Card title="Invoice reconciliation">
        <div className="grid gap-4 lg:grid-cols-2">
          <fieldset disabled={locked} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Tax"><Input inputMode="decimal" value={header.tax} onChange={(e) => setH("tax", e.target.value)} /></Field>
            <Field label="Freight"><Input inputMode="decimal" value={header.freight} onChange={(e) => setH("freight", e.target.value)} /></Field>
            <Field label="Fuel surcharge"><Input inputMode="decimal" value={header.fuel_surcharge} onChange={(e) => setH("fuel_surcharge", e.target.value)} /></Field>
            <Field label="Misc fees"><Input inputMode="decimal" value={header.misc_fees} onChange={(e) => setH("misc_fees", e.target.value)} /></Field>
            <Field label="Credits"><Input inputMode="decimal" value={header.credits} onChange={(e) => setH("credits", e.target.value)} /></Field>
            {live.shortageCredit.gt(0) && !locked ? (
              <div className="col-span-2 flex items-end sm:col-span-1"><Button size="sm" className="whitespace-normal" onClick={() => setH("credits", live.shortageCredit.toFixed(2))}>Credit shortages ({money(live.shortageCredit.toNumber())})</Button></div>
            ) : null}
          </fieldset>
          <div className="rounded-md bg-surface-2 p-3 text-sm">
            {[["Line items", live.linesTotal], ["+ Tax, freight, fuel, fees", D(header.tax).plus(D(header.freight)).plus(D(header.fuel_surcharge)).plus(D(header.misc_fees))], ["− Credits", D(header.credits)]].map(([k, v]) => (
              <div key={k as string} className="flex justify-between py-0.5"><span>{k as string}</span><span className="tabular-nums">{money((v as Decimal).toNumber())}</span></div>
            ))}
            <div className="mt-1 flex justify-between border-t border-border-strong pt-1 font-semibold"><span>CALCULATED TOTAL</span><span className="tabular-nums" data-testid="calc-total">{money(live.calc.toNumber())}</span></div>
            <div className="flex justify-between font-semibold"><span>INVOICE TOTAL</span><span className="tabular-nums">{live.inv ? money(live.inv.toNumber()) : "—"}</span></div>
            <div className={cx("mt-1 flex justify-between rounded px-2 py-1 font-bold", live.overShort === null ? "" : within ? "bg-success-soft text-success" : "bg-danger-soft text-danger")}>
              <span>OVER / SHORT</span><span className="tabular-nums" data-testid="over-short">{live.overShort === null ? "Enter invoice total" : money(live.overShort.toNumber(), { sign: true })}</span>
            </div>
            <div className="mt-1 text-xs text-muted">Tolerance ±{money(totals.tolerance)}. Value received into inventory: {money(lines.reduce((s, l) => s + Number(l.received_qty ?? 0) * Number(l.invoice_price ?? l.contract_price ?? 0), 0))}</div>
          </div>
        </div>
      </Card>

      {tempProblems.length ? <Notice tone="danger" title="Temperature out of range"><span className="inline-flex items-center gap-1"><Thermometer className="h-4 w-4" />Open the line and choose Accept, Reject or Manager Override for: {tempProblems.map((l) => l.product_name).join(", ")}</span></Notice> : null}

      {["draft", "received"].includes(p.status) ? (
        <div className="sticky bottom-16 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/95 p-3 backdrop-blur lg:bottom-2">
          <span className="text-sm text-muted">{dirty ? "Unsaved changes" : "All changes saved"}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => { const r = prompt("Reason for cancelling this receipt?"); if (r) run(async () => { const x = await cancelReceipt(p.receiptId, r); if (x?.ok) router.push("/receiving"); else toast({ tone: "error", text: x?.error ?? "Failed" }); }); }} disabled={pending}>Cancel receipt</Button>
            {p.canReceive ? <Button onClick={save} disabled={pending || !dirty}>{pending ? "Saving…" : "Save"}</Button> : null}
            {p.status === "draft" && p.canReceive ? <Button variant="primary" onClick={complete} disabled={pending}>Complete receiving</Button> : null}
            {p.canReconcile ? <Button variant={p.status === "received" ? "primary" : "secondary"} onClick={() => setPostDialog(true)} disabled={pending}>Reconcile & post</Button> : null}
          </div>
        </div>
      ) : null}

      <Modal open={postDialog} onClose={() => setPostDialog(false)} title="Reconcile and post invoice">
        <div className="space-y-2 text-sm">
          <p>Posting adds received quantities to inventory, updates average and latest cost, records price history, closes or back-orders PO lines and locks this receipt. It happens all at once or not at all.</p>
          <div className="rounded-md bg-surface-2 p-2">Calculated {money(live.calc.toNumber())} · Invoice {live.inv ? money(live.inv.toNumber()) : "—"} · Over/short <b className={within ? "text-success" : "text-danger"}>{live.overShort ? money(live.overShort.toNumber(), { sign: true }) : "—"}</b></div>
          {!within && live.overShort !== null ? (
            p.canOverride ? (
              <Field label="Override reason (required: invoice is outside tolerance)"><Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} placeholder="Vendor credit memo #1234 to follow" /></Field>
            ) : <p className="flex items-center gap-1 text-danger"><AlertTriangle className="h-4 w-4" /> Out of tolerance. A manager with override permission must post this invoice.</p>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setPostDialog(false)}>Back</Button>
          <Button variant="primary" onClick={post} disabled={pending || (!within && live.overShort !== null && (!p.canOverride || !overrideReason.trim()))}>{pending ? "Posting…" : "Reconcile & post"}</Button>
        </div>
      </Modal>
    </div>
  );
}

function QtyInput({ label, value, onChange, disabled, unit, prefix, testId }: { label: string; value: number | null; onChange: (v: number | null) => void; disabled: boolean; unit?: string; prefix?: string; testId?: string }) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    // keep in sync when the value changes from outside (e.g. "everything arrived as ordered")
    setText((t) => ((t === "" ? null : Number(t)) === value ? t : value === null ? "" : String(value)));
  }, [value]);
  return (
    <label className="flex items-center justify-between gap-1 lg:justify-center">
      <span className="text-[11px] text-muted lg:hidden">{label}</span>
      <span className="flex items-center gap-1">
        {prefix ? <span className="text-xs text-muted">{prefix}</span> : null}
        <input inputMode="decimal" disabled={disabled} value={text} aria-label={label} data-testid={testId}
          onChange={(e) => { const t = e.target.value.replace(/[^0-9.]/g, ""); setText(t); onChange(t === "" ? null : Number(t)); }}
          className={cx(inputBase, "h-9 w-20 text-right tabular-nums")} />
        {unit ? <span className="text-[11px] text-muted">{unit}</span> : null}
      </span>
    </label>
  );
}

function LineDetails({ line: l, locked, storages, onChange }: { line: RLine; locked: boolean; storages: { id: string; name: string }[]; onChange: (p: Partial<RLine>) => void }) {
  const tempBad = l.temperature !== null && ((l.temp_max !== null && l.temperature > l.temp_max) || (l.temp_min !== null && l.temperature < l.temp_min));
  const alloc = (sid: string) => l.storage_allocations.find((a) => a.storage_location_id === sid)?.qty ?? "";
  const setAlloc = (sid: string, v: string) => onChange({ storage_allocations: [...l.storage_allocations.filter((a) => a.storage_location_id !== sid), ...(v ? [{ storage_location_id: sid, qty: Number(v) }] : [])] });
  const allocated = l.storage_allocations.reduce((s, a) => s + Number(a.qty), 0);
  return (
    <fieldset disabled={locked} className="grid gap-3 border-t border-border bg-surface-2/60 px-3 py-3 sm:grid-cols-2 lg:grid-cols-4">
      {l.po_item_id && (l.received_qty ?? l.ordered_qty) < l.ordered_qty ? (
        <label className="flex items-center gap-2 text-sm sm:col-span-2 lg:col-span-4">
          <input type="checkbox" checked={l.back_order} onChange={(e) => onChange({ back_order: e.target.checked })} />
          Back order the missing {qty(l.ordered_qty - (l.received_qty ?? 0), l.unit_code)} (keep it open on the PO)
        </label>
      ) : null}
      <Field label={`Rejected (${l.unit_code})`}><Input inputMode="decimal" value={toS(l.rejected_qty || "")} onChange={(e) => onChange({ rejected_qty: Number(e.target.value || 0) })} /></Field>
      <Field label={`Damaged (${l.unit_code})`}><Input inputMode="decimal" value={toS(l.damaged_qty || "")} onChange={(e) => onChange({ damaged_qty: Number(e.target.value || 0) })} /></Field>
      <Field label={`Catch weight (actual ${l.inventory_unit})`} hint={l.catch_weight ? "Required for catch-weight items" : "Optional"}>
        <Input inputMode="decimal" value={toS(l.catch_weight_qty)} onChange={(e) => onChange({ catch_weight_qty: e.target.value ? Number(e.target.value) : null })} />
      </Field>
      <Field label="Invoice extended $ (override)"><Input inputMode="decimal" value={toS(l.invoice_extended)} onChange={(e) => onChange({ invoice_extended: e.target.value ? Number(e.target.value) : null })} placeholder="qty × price" /></Field>
      <Field label={`Temperature °F${l.temp_max !== null ? ` (≤ ${l.temp_max})` : ""}${l.temp_min !== null ? ` (≥ ${l.temp_min})` : ""}`}>
        <Input inputMode="decimal" value={toS(l.temperature)} onChange={(e) => onChange({ temperature: e.target.value === "" ? null : Number(e.target.value) })} className={tempBad ? "border-danger" : ""} />
      </Field>
      {tempBad ? (
        <Field label="Temperature decision" className="sm:col-span-1">
          <Select value={l.temp_decision ?? ""} onChange={(e) => onChange({ temp_decision: e.target.value || null })}>
            <option value="">Choose…</option><option value="reject">Reject (send back)</option><option value="accept">Accept</option><option value="override">Manager override</option>
          </Select>
        </Field>
      ) : null}
      <Field label="Lot number"><Input value={toS(l.lot_number)} onChange={(e) => onChange({ lot_number: e.target.value || null })} /></Field>
      <Field label="Traceability lot code"><Input value={toS(l.lot_tlc)} onChange={(e) => onChange({ lot_tlc: e.target.value || null })} /></Field>
      <Field label="Production date"><Input type="date" value={toS(l.lot_production_date)} onChange={(e) => onChange({ lot_production_date: e.target.value || null })} /></Field>
      <Field label="Expiration date"><Input type="date" value={toS(l.expiration_date)} onChange={(e) => onChange({ expiration_date: e.target.value || null })} /></Field>
      <div className="sm:col-span-2 lg:col-span-4">
        <div className="mb-1 text-xs font-medium text-muted">Put away into storage ({l.unit_code}) — {allocated} of {l.received_qty ?? 0} assigned{allocated < Number(l.received_qty ?? 0) ? "; the rest is recorded without a storage area" : ""}</div>
        <div className="flex flex-wrap gap-2">
          {storages.map((s) => (
            <label key={s.id} className="flex items-center gap-1 text-sm">
              <span className="text-xs">{s.name}</span>
              <input inputMode="decimal" value={toS(alloc(s.id))} onChange={(e) => setAlloc(s.id, e.target.value.replace(/[^0-9.]/g, ""))} className={cx(inputBase, "h-8 w-16 text-right")} aria-label={`${s.name} quantity`} />
            </label>
          ))}
        </div>
      </div>
      <Field label="Line notes" className="sm:col-span-2 lg:col-span-4"><Input value={toS(l.notes)} onChange={(e) => onChange({ notes: e.target.value })} /></Field>
    </fieldset>
  );
}
