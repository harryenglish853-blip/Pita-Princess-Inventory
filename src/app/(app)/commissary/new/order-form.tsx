"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { HelpCircle } from "lucide-react";
import { Button, Field, Input, Notice, Select, cx, inputBase } from "@/components/ui";
import { Modal, useToast } from "@/components/client";
import { qty as fq } from "@/lib/format";
import { Explanation } from "../../purchasing/order-builder";
import type { SuggestionRow } from "../../purchasing/load-suggestions";
import { saveCommissaryOrder } from "../actions";

export type FormRow = {
  product_id: string; name: string; inventory_unit: string; on_hand: number; incoming: number; suggested: number; suggested_unit_id: string;
  explanation: SuggestionRow; units: { id: string; code: string; factor: number }[]; unit_id: string; qty: string; notes: string;
};

export function CommissaryOrderForm({ orderId, vendorId, neededDate, notes: initialNotes, rows, error }: {
  orderId: string | null; vendorId: string; neededDate: string; notes: string; rows: FormRow[]; error: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [clientKey] = useState(() => crypto.randomUUID());
  const [needed, setNeeded] = useState(neededDate);
  const [notes, setNotes] = useState(initialNotes);
  const [lines, setLines] = useState(rows);
  const [why, setWhy] = useState<SuggestionRow | null>(null);
  const count = lines.filter((l) => Number(l.qty) > 0).length;
  const set = (i: number, patch: Partial<FormRow>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  function save(submit: boolean) {
    start(async () => {
      const res = await saveCommissaryOrder({ id: orderId, vendorId, neededDate: needed, notes, clientKey, submit,
        lines: lines.map((l) => ({ product_id: l.product_id, unit_id: l.unit_id, qty: l.qty || "0", notes: l.notes || null })) });
      if (res?.ok) { toast({ tone: "success", text: res.message ?? "Saved" }); router.push(`/commissary/${res.data!.id}`); }
      else { toast({ tone: "error", text: res?.error ?? "Could not save" }); if (res?.data?.id) router.push(`/commissary/${res.data.id}`); }
    });
  }

  return (
    <div className="space-y-3">
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <Field label="Needed"><Input type="date" value={needed} onChange={(e) => setNeeded(e.target.value)}
          onBlur={() => { if (needed !== neededDate && !orderId) router.push(`/commissary/new?needed=${needed}`); }} /></Field>
        <Field label="Notes for the commissary"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery instructions…" /></Field>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        {lines.map((l, i) => (
          <div key={l.product_id} className={cx("grid gap-2 border-b border-border px-3 py-3 sm:grid-cols-[1fr_auto] sm:items-center", Number(l.qty) > 0 && "bg-brand-soft/40")}>
            <div>
              <div className="font-medium">{l.name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                <span>On hand {fq(l.on_hand, l.inventory_unit)}</span><span>Incoming {fq(l.incoming, l.inventory_unit)}</span>
                <span>Suggested <b className="text-text">{l.suggested} {l.units.find((u) => u.id === l.suggested_unit_id)?.code}</b></span>
                <button type="button" className="inline-flex items-center gap-1 font-semibold text-brand" onClick={() => setWhy(l.explanation)}><HelpCircle className="h-3.5 w-3.5" /> WHY?</button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input inputMode="decimal" aria-label={`Quantity ${l.name}`} value={l.qty} placeholder="0"
                onChange={(e) => { const v = e.target.value.trim(); if (v === "" || /^\d+(\.\d{0,4})?$/.test(v)) set(i, { qty: v }); }}
                className={cx(inputBase, "h-11 w-20 text-center text-base font-semibold")} />
              <Select aria-label={`Unit ${l.name}`} value={l.unit_id} onChange={(e) => set(i, { unit_id: e.target.value })} className="h-11 w-28">
                {l.units.map((u) => <option key={u.id} value={u.id}>{u.code}{u.factor !== 1 ? ` (${u.factor} ${l.inventory_unit})` : ""}</option>)}
              </Select>
            </div>
          </div>
        ))}
        {!lines.length ? <p className="p-6 text-center text-sm text-muted">The commissary has no items on its order guide yet. Add them on the Commissary vendor.</p> : null}
      </div>
      <div className="sticky bottom-16 z-10 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface/95 p-3 backdrop-blur lg:bottom-2">
        <span className="text-sm"><b>{count}</b> items</span>
        <div className="ml-auto flex gap-2">
          <Button onClick={() => save(false)} disabled={pending}>Save draft</Button>
          <Button variant="primary" onClick={() => save(true)} disabled={pending || !count}>{pending ? "Submitting…" : "Submit to commissary"}</Button>
        </div>
      </div>
      <Modal open={!!why} onClose={() => setWhy(null)} title={why ? `Why ${Number(why.suggested_qty)} ${why.purchase_unit}? — ${why.product_name}` : ""}>
        {why ? <Explanation row={why} /> : null}
      </Modal>
    </div>
  );
}
