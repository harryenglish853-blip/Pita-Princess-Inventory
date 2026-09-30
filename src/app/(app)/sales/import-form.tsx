"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Card, Field, Input, Notice, Select } from "@/components/ui";
import { useToast } from "@/components/client";
import { POS_ADAPTERS, getAdapter, type NormalizedSales } from "@/lib/pos/adapters";
import { money } from "@/lib/format";
import { importSales } from "./actions";

export function ImportForm({ yesterday, menu }: { yesterday: string; menu: { name: string; pos_item_id: string | null; mapped: boolean }[] }) {
  const [source, setSource] = useState("csv");
  const [date, setDate] = useState(yesterday);
  const [fileName, setFileName] = useState("");
  const [data, setData] = useState<NormalizedSales | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  const adapter = getAdapter(source)!;
  const isMapped = (l: { pos_item_id: string | null; item_name: string }) =>
    menu.some((m) => m.mapped && ((l.pos_item_id && m.pos_item_id === l.pos_item_id) || m.name.toLowerCase() === l.item_name.toLowerCase()));

  async function onFile(f: File | undefined) {
    setError(null); setData(null);
    if (!f) return;
    setFileName(f.name);
    try { setData(adapter.parse!(await f.text())); } catch (e) { setError((e as Error).message); }
  }
  const setSummary = (k: keyof NormalizedSales["summary"], v: string) => setData((d) => d && ({ ...d, summary: { ...d.summary, [k]: Number(v) || 0 } }));

  return (
    <Card title="Import POS sales">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="POS"><Select value={source} onChange={(e) => { setSource(e.target.value); setData(null); }}>
            {POS_ADAPTERS.map((a) => <option key={a.id} value={a.id} disabled={a.kind !== "file"}>{a.name}{a.kind === "api" ? " (API — not connected)" : ""}</option>)}
          </Select></Field>
          <Field label="Business date"><Input type="date" value={date} max={yesterday.slice(0, 10) > date ? undefined : undefined} onChange={(e) => setDate(e.target.value)} /></Field>
        </div>
        <p className="text-xs text-muted">{adapter.description}</p>
        <input type="file" accept=".csv,text/csv" aria-label="Sales file" onChange={(e) => onFile(e.target.files?.[0])} className="block w-full text-sm" />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {data ? (
          <>
            {data.warnings.map((w) => <Notice key={w} tone="warning">{w}</Notice>)}
            <div className="grid grid-cols-3 gap-2">
              <Field label="Net sales $"><Input inputMode="decimal" value={data.summary.net_sales} onChange={(e) => setSummary("net_sales", e.target.value)} /></Field>
              <Field label="Guests"><Input inputMode="numeric" value={data.summary.guest_count} onChange={(e) => setSummary("guest_count", e.target.value)} /></Field>
              <Field label="Checks"><Input inputMode="numeric" value={data.summary.check_count} onChange={(e) => setSummary("check_count", e.target.value)} /></Field>
            </div>
            <div className="max-h-64 overflow-y-auto rounded border border-border">
              <table className="tbl"><thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Net</th><th>Recipe</th></tr></thead>
                <tbody>{data.lines.map((l, i) => (
                  <tr key={i}><td>{l.item_name}{l.pos_item_id ? <span className="text-xs text-muted"> · {l.pos_item_id}</span> : null}</td><td className="num">{l.quantity}</td><td className="num">{money(l.net_sales)}</td>
                    <td>{isMapped(l) ? <Badge tone="success">Mapped</Badge> : <Badge tone="warning">Unmapped</Badge>}</td></tr>
                ))}</tbody></table>
            </div>
            <p className="text-xs text-muted">Importing posts theoretical consumption for every mapped item (menu items sold × recipe). Unmapped items are kept and can be mapped afterwards.</p>
            <Button variant="primary" className="w-full" disabled={pending} onClick={() => start(async () => {
              const r = await importSales({ businessDate: date, source, fileName, data });
              if (r?.ok) { toast({ tone: "success", text: r.message! }); setData(null); router.push(`/sales/${r.data!.id}`); } else toast({ tone: "error", text: r?.error ?? "Import failed" });
            })}>{pending ? "Importing…" : `Import ${data.lines.length} items for ${date}`}</Button>
          </>
        ) : null}
      </div>
    </Card>
  );
}
