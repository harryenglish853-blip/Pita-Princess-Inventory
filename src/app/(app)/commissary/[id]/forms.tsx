"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, cx, inputBase } from "@/components/ui";
import { Modal, useToast } from "@/components/client";
import { receiveCommissaryOrder, shipCommissaryOrder } from "../actions";

export type Line = { id: string; product_name: string; unit_code: string; unit_factor: number; inventory_unit: string;
  qty_ordered: number; qty_shipped: number | null; qty_received: number | null; unit_cost: number | null };

const valid = (v: string) => v === "" || /^\d+(\.\d{0,4})?$/.test(v);

function QtyTable({ lines, label, base, values, onChange }: { lines: Line[]; label: string; base: (l: Line) => number; values: Record<string, string>; onChange: (id: string, v: string) => void }) {
  return (
    <div className="divide-y divide-border">
      {lines.map((l) => (
        <div key={l.id} className="flex items-center justify-between gap-3 py-2">
          <div><div className="font-medium">{l.product_name}</div><div className="text-xs text-muted">{label === "Shipped" ? "Ordered" : "Shipped"} {Number(base(l))} {l.unit_code}</div></div>
          <label className="flex items-center gap-2 text-sm">
            <input inputMode="decimal" aria-label={`${label} ${l.product_name}`} value={values[l.id] ?? ""} onChange={(e) => valid(e.target.value.trim()) && onChange(l.id, e.target.value.trim())}
              className={cx(inputBase, "h-12 w-24 text-center text-lg font-semibold", Number(values[l.id] || 0) !== Number(base(l)) && "border-warning")} />
            <span className="w-10">{l.unit_code}</span>
          </label>
        </div>
      ))}
    </div>
  );
}

/** Commissary staff: confirm what actually goes on the truck. */
export function ShipForm({ orderId, lines }: { orderId: string; lines: Line[] }) {
  const [v, setV] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, String(Number(l.qty_ordered))])));
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <Card title="Ship to the restaurant">
      <QtyTable lines={lines} label="Shipped" base={(l) => l.qty_ordered} values={v} onChange={(id, x) => setV((s) => ({ ...s, [id]: x }))} />
      <Button variant="primary" size="lg" className="mt-3 w-full sm:w-auto" onClick={() => setOpen(true)}>Ship order</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Ship this order?">
        <p className="text-sm">Stock leaves the commissary now. The restaurant confirms what arrives.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>Back</Button>
          <Button variant="primary" disabled={pending} onClick={() => start(async () => {
            const r = await shipCommissaryOrder(orderId, lines.map((l) => ({ id: l.id, qty_shipped: v[l.id] || "0" })));
            setOpen(false);
            if (r?.ok) { toast({ tone: "success", text: r.message! }); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
          })}>{pending ? "Shipping…" : "Ship"}</Button>
        </div>
      </Modal>
    </Card>
  );
}

/** Restaurant: count what arrived. Starts blank so nobody confirms without counting. */
export function ReceiveForm({ orderId, lines }: { orderId: string; lines: Line[] }) {
  const [v, setV] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const missing = lines.filter((l) => (v[l.id] ?? "") === "").length;
  const diffs = lines.filter((l) => v[l.id] !== undefined && v[l.id] !== "" && Number(v[l.id]) !== Number(l.qty_ordered));
  return (
    <Card title="Receive this delivery" className="border-brand">
      <p className="mb-2 text-sm text-muted">Count each item and enter what arrived. Enter 0 for anything missing.</p>
      <QtyTable lines={lines} label="Received" base={(l) => l.qty_shipped ?? 0} values={v} onChange={(id, x) => setV((s) => ({ ...s, [id]: x }))} />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button variant="secondary" onClick={() => setV(Object.fromEntries(lines.map((l) => [l.id, String(Number(l.qty_shipped ?? 0))])))}>Everything arrived as shipped</Button>
        <Button variant="primary" size="lg" disabled={pending || missing > 0} onClick={() => start(async () => {
          const r = await receiveCommissaryOrder(orderId, lines.map((l) => ({ id: l.id, qty_received: v[l.id] })));
          if (r?.ok) { toast({ tone: r.data?.issues ? "info" : "success", text: r.message! }); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
        })}>{pending ? "Saving…" : missing ? `Enter ${missing} more` : diffs.length ? `Confirm with ${diffs.length} difference${diffs.length === 1 ? "" : "s"}` : "Confirm received"}</Button>
      </div>
    </Card>
  );
}
