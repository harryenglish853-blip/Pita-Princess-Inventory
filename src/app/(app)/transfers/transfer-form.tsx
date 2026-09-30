"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, Field, Input, Select, cx, inputBase } from "@/components/ui";
import { useToast } from "@/components/client";
import { createTransfer } from "./actions";

export function TransferForm({ storages, locations, products, units, canLocation }: {
  storages: { id: string; name: string }[]; locations: { id: string; label: string }[];
  products: { id: string; name: string; unit_id: string }[]; units: { product_id: string; unit_id: string; code: string }[]; canLocation: boolean;
}) {
  const [type, setType] = useState<"storage" | "location">("storage");
  const [from, setFrom] = useState(storages[0]?.id ?? "");
  const [to, setTo] = useState(storages[1]?.id ?? "");
  const [toLoc, setToLoc] = useState(locations[0]?.id ?? "");
  const [lines, setLines] = useState<{ product_id: string; unit_id: string; qty: string }[]>([{ product_id: "", unit_id: "", qty: "" }]);
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const set = (i: number, patch: Partial<(typeof lines)[number]>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  function submit() {
    const valid = lines.filter((l) => l.product_id && Number(l.qty) > 0);
    if (!valid.length) { toast({ tone: "error", text: "Add at least one item" }); return; }
    start(async () => {
      const r = await createTransfer({ type, from: type === "storage" ? from : null, to: type === "storage" ? to : toLoc, lines: valid, notes, clientKey: key });
      if (r?.ok) { toast({ tone: "success", text: r.message! }); setKey(crypto.randomUUID()); setLines([{ product_id: "", unit_id: "", qty: "" }]); router.push(type === "location" ? `/transfers/${r.data!.id}` : "/transfers"); router.refresh(); }
      else toast({ tone: "error", text: r?.error ?? "Failed" });
    });
  }
  return (
    <Card title="New transfer">
      <div className="mb-3 inline-flex rounded-md border border-border p-0.5 text-sm">
        <button type="button" onClick={() => setType("storage")} className={cx("rounded px-3 py-1", type === "storage" && "bg-brand text-white")}>Storage → storage</button>
        {canLocation ? <button type="button" onClick={() => setType("location")} className={cx("rounded px-3 py-1", type === "location" && "bg-brand text-white")}>To another restaurant</button> : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {type === "storage" ? (<>
          <Field label="From"><Select value={from} onChange={(e) => setFrom(e.target.value)}>{storages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="To"><Select value={to} onChange={(e) => setTo(e.target.value)}>{storages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        </>) : (
          <Field label="To restaurant" className="sm:col-span-2"><Select value={toLoc} onChange={(e) => setToLoc(e.target.value)}>{locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</Select></Field>
        )}
      </div>
      <div className="mt-3 space-y-2">
        {lines.map((l, i) => (
          <div key={i} className="flex gap-2">
            <select aria-label="Product" value={l.product_id} onChange={(e) => { const p = products.find((x) => x.id === e.target.value); set(i, { product_id: e.target.value, unit_id: p?.unit_id ?? "" }); }} className={cx(inputBase, "min-w-0 flex-1")}>
              <option value="">Product…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input aria-label="Quantity" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value.replace(/[^0-9.]/g, "") })} placeholder="Qty" className={cx(inputBase, "w-20")} />
            <select aria-label="Unit" value={l.unit_id} onChange={(e) => set(i, { unit_id: e.target.value })} className={cx(inputBase, "w-24")}>
              {units.filter((u) => u.product_id === l.product_id).map((u) => <option key={u.unit_id} value={u.unit_id}>{u.code}</option>)}
            </select>
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setLines((ls) => [...ls, { product_id: "", unit_id: "", qty: "" }])}>+ Add item</Button>
      </div>
      <Field label="Notes" className="mt-2"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      <Button variant="primary" className="mt-3 w-full" onClick={submit} disabled={pending || (type === "storage" && from === to)}>
        {pending ? "Saving…" : type === "storage" ? "Move now" : "Create transfer"}
      </Button>
    </Card>
  );
}
