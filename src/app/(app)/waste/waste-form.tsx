"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Minus, Plus, X } from "lucide-react";
import { Button, Card, Field, Input, Select, cx, inputBase } from "@/components/ui";
import { useToast } from "@/components/client";
import { evaluate } from "@/lib/calc";
import { logWaste } from "./actions";

type Item = { kind: "product" | "recipe"; id: string; name: string; unit: string; unit_id?: string };

async function compress(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 800 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.6);
}

export function WasteForm({ products, recipes, units, reasons, storages, canBackdate }: {
  products: { id: string; name: string; unit: string }[];
  recipes: { id: string; name: string; unit_id: string; unit: string }[];
  units: { product_id: string; unit_id: string; code: string }[];
  reasons: { code: string; name: string; requires_comment: boolean }[];
  storages: { id: string; name: string }[]; canBackdate: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [query, setQuery] = useState("");
  const [item, setItem] = useState<Item | null>(null);
  const [qty, setQty] = useState("");
  const [unitId, setUnitId] = useState("");
  const [reason, setReason] = useState("");
  const [storage, setStorage] = useState("");
  const [comment, setComment] = useState("");
  const [photo, setPhoto] = useState<string | null>(null);
  const [at, setAt] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());

  const all: Item[] = useMemo(() => [
    ...products.map((p) => ({ kind: "product" as const, id: p.id, name: p.name, unit: p.unit })),
    ...recipes.map((r) => ({ kind: "recipe" as const, id: r.id, name: `${r.name} (prepared)`, unit: r.unit, unit_id: r.unit_id })),
  ], [products, recipes]);
  const matches = query.trim() ? all.filter((i) => i.name.toLowerCase().includes(query.toLowerCase())).slice(0, 8) : [];
  const unitChoices = item?.kind === "product" ? units.filter((u) => u.product_id === item.id) : item ? [{ unit_id: item.unit_id!, code: item.unit, product_id: "" }] : [];
  const reasonObj = reasons.find((r) => r.code === reason);
  const value = evaluate(qty);

  function choose(i: Item) {
    setItem(i); setQuery("");
    const base = i.kind === "product" ? units.find((u) => u.product_id === i.id && u.code === i.unit)?.unit_id : i.unit_id;
    setUnitId(base ?? "");
    setTimeout(() => document.getElementById("waste-qty")?.focus(), 30);
  }

  function submit() {
    if (!item || !value || value <= 0 || !unitId || !reason) { toast({ tone: "error", text: "Choose an item, quantity and reason" }); return; }
    if (reasonObj?.requires_comment && !comment.trim()) { toast({ tone: "error", text: "Add a comment for this reason" }); return; }
    start(async () => {
      const r = await logWaste({ kind: item.kind, id: item.id, qty: String(value), unitId, reason, storageId: storage || null, comment: comment || null, photo, clientKey: key, at: at ? new Date(at).toISOString() : null });
      if (r?.ok) {
        toast({ tone: "success", text: `${item.name}: ${r.message}` });
        setItem(null); setQty(""); setComment(""); setPhoto(null); setKey(crypto.randomUUID());
        router.refresh();
      } else toast({ tone: "error", text: r?.error ?? "Failed" });
    });
  }

  return (
    <Card title="Log waste">
      <div className="space-y-4">
        {item ? (
          <div className="flex items-center justify-between rounded-md border border-brand bg-brand-soft px-3 py-2">
            <span className="font-semibold">{item.name}</span>
            <button type="button" aria-label="Change item" onClick={() => setItem(null)} className="rounded p-1 hover:bg-surface"><X className="h-4 w-4" /></button>
          </div>
        ) : (
          <div className="relative">
            <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="What was wasted? (product or menu item)" aria-label="Search item" />
            {matches.length ? (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-lg">
                {matches.map((m) => <li key={m.kind + m.id}><button type="button" onClick={() => choose(m)} className="w-full px-3 py-2 text-left text-sm hover:bg-surface-2">{m.name}</button></li>)}
              </ul>
            ) : null}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Less" onClick={() => setQty(String(Math.max(0, (value ?? 0) - 1)))} className="grid h-12 w-12 place-items-center rounded-lg border border-border-strong"><Minus className="h-5 w-5" /></button>
          <input id="waste-qty" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="Qty" aria-label="Quantity"
            className={cx(inputBase, "h-12 min-w-0 flex-1 text-center text-xl font-semibold", qty && value === null && "border-danger")} />
          <button type="button" aria-label="More" onClick={() => setQty(String((value ?? 0) + 1))} className="grid h-12 w-12 place-items-center rounded-lg border border-border-strong"><Plus className="h-5 w-5" /></button>
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-label="Unit" className={cx(inputBase, "h-12 w-24")}>
            {unitChoices.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.code}</option>)}
          </select>
        </div>
        <div>
          <div className="mb-1 text-xs font-medium text-muted">Reason</div>
          <div className="grid grid-cols-3 gap-1.5">
            {reasons.map((r) => (
              <button key={r.code} type="button" onClick={() => setReason(r.code)}
                className={cx("rounded-md border px-2 py-2 text-xs font-medium", reason === r.code ? "border-brand bg-brand text-white" : "border-border bg-surface hover:bg-surface-2")}>{r.name}</button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Storage"><Select value={storage} onChange={(e) => setStorage(e.target.value)}><option value="">—</option>{storages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          {canBackdate ? <Field label="When (optional)"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field> : null}
        </div>
        <Field label={`Comment${reasonObj?.requires_comment ? " (required)" : " (optional)"}`}><Input value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
        <div className="flex items-center gap-2">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-strong px-3 py-2 text-sm">
            <Camera className="h-4 w-4" /> {photo ? "Retake photo" : "Photo (optional)"}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setPhoto(await compress(f)); }} />
          </label>
          {photo ? <img src={photo} alt="Waste" className="h-10 w-10 rounded object-cover" /> : null}
        </div>
        <Button variant="primary" size="lg" className="w-full" onClick={submit} disabled={pending}>{pending ? "Saving…" : "Log waste"}</Button>
      </div>
    </Card>
  );
}
