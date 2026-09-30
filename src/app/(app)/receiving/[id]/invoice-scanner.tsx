"use client";
import { useState, useTransition } from "react";
import { ScanText } from "lucide-react";
import { Badge, Button, Notice, cx, inputBase } from "@/components/ui";
import { Modal } from "@/components/client";
import { money } from "@/lib/format";
import type { ExtractedInvoice } from "@/lib/ai/invoice-extract";
import { scanInvoice } from "../actions";

type Line = { id: string; product_name: string; vendor_item_number: string | null; unit_code: string };
export type ScanApply = {
  header: Partial<Record<"invoice_number" | "invoice_date" | "invoice_total" | "tax" | "freight" | "fuel_surcharge" | "misc_fees" | "credits", string>>;
  lines: { id: string; invoiced_qty: number | null; invoice_price: number | null }[];
};

async function shrink(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
  const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.85));
  return new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" });
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function autoMatch(ex: ExtractedInvoice["lines"][number], lines: Line[]): string {
  if (ex.vendor_item_number) {
    const m = lines.find((l) => l.vendor_item_number && norm(l.vendor_item_number) === norm(ex.vendor_item_number!));
    if (m) return m.id;
  }
  const words = norm(ex.description).split(" ").filter((w) => w.length > 2);
  let best = { id: "", score: 0 };
  for (const l of lines) {
    const n = norm(l.product_name);
    const score = words.filter((w) => n.includes(w)).length / Math.max(words.length, 1);
    if (score > best.score) best = { id: l.id, score };
  }
  return best.score >= 0.5 ? best.id : "";
}

/** Photo/PDF -> AI extraction -> side-by-side review -> apply to the (unsaved) receipt. Nothing is saved or posted here. */
export function InvoiceScanner({ receiptId, lines, onApply }: { receiptId: string; lines: Line[]; onApply: (a: ScanApply) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [inv, setInv] = useState<ExtractedInvoice | null>(null);
  const [match, setMatch] = useState<string[]>([]);

  function onFile(f: File | undefined) {
    if (!f) return;
    setError(null); setInv(null);
    start(async () => {
      const fd = new FormData();
      fd.set("file", await shrink(f));
      const r = await scanInvoice(receiptId, fd);
      if (!r?.ok) { setError(r?.error ?? "Could not read the invoice"); return; }
      setInv(r.data!.invoice);
      setMatch(r.data!.invoice.lines.map((l) => autoMatch(l, lines)));
    });
  }
  function apply() {
    if (!inv) return;
    const s = (v: number | string | null | undefined) => (v === null || v === undefined ? undefined : String(v));
    onApply({
      header: { invoice_number: s(inv.invoice_number), invoice_date: s(inv.invoice_date), invoice_total: s(inv.total), tax: s(inv.tax),
                freight: s(inv.freight), fuel_surcharge: s(inv.fuel_surcharge), misc_fees: s(inv.misc_fees), credits: s(inv.credits) },
      lines: inv.lines.map((l, i) => ({ id: match[i], invoiced_qty: l.quantity, invoice_price: l.unit_price })).filter((l) => l.id),
    });
    setOpen(false);
  }
  const unmatched = inv ? inv.lines.filter((_, i) => !match[i]).length : 0;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}><ScanText className="h-4 w-4" /> Scan invoice</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Scan vendor invoice" wide>
        <div className="space-y-3">
          <p className="text-sm text-muted">Take a photo or upload the invoice. The values are read automatically, then <b>you</b> check them. Nothing is saved until you apply them and save the receipt.</p>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-strong px-3 py-2 text-sm">
            {pending ? "Reading invoice…" : "Take photo / choose file"}
            <input type="file" accept="image/*,application/pdf" capture="environment" className="hidden" disabled={pending} onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {inv ? (
            <>
              <div className="grid gap-2 text-sm sm:grid-cols-4">
                <div><div className="text-xs text-muted">Vendor</div>{inv.vendor_name ?? "—"}</div>
                <div><div className="text-xs text-muted">Invoice #</div>{inv.invoice_number ?? "—"}</div>
                <div><div className="text-xs text-muted">Date</div>{inv.invoice_date ?? "—"}</div>
                <div><div className="text-xs text-muted">Total</div>{money(inv.total)}</div>
                <div><div className="text-xs text-muted">Tax / freight / fuel / fees</div>{[inv.tax, inv.freight, inv.fuel_surcharge, inv.misc_fees].map((v) => money(v ?? 0)).join(" / ")}</div>
                <div><div className="text-xs text-muted">Credits</div>{money(inv.credits ?? 0)}</div>
              </div>
              {inv.notes ? <Notice tone="warning" title="Check these">{inv.notes}</Notice> : null}
              <div className="max-h-80 overflow-y-auto rounded border border-border">
                <table className="tbl">
                  <thead><tr><th>Invoice line</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Ext.</th><th>Receipt line</th></tr></thead>
                  <tbody>{inv.lines.map((l, i) => (
                    <tr key={i}>
                      <td><div className="font-medium">{l.description}</div><div className="text-xs text-muted">{l.vendor_item_number ?? ""} {l.unit ?? ""}</div></td>
                      <td className="num">{l.quantity ?? "—"}</td><td className="num">{money(l.unit_price)}</td><td className="num">{money(l.extended_price)}</td>
                      <td>
                        <select aria-label={`Match ${l.description}`} value={match[i] ?? ""} onChange={(e) => setMatch((m) => m.map((x, j) => (j === i ? e.target.value : x)))} className={cx(inputBase, "h-8 max-w-52 text-xs")}>
                          <option value="">Not matched</option>{lines.map((r) => <option key={r.id} value={r.id}>{r.product_name}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              {unmatched ? <p className="text-xs text-warning">{unmatched} line(s) are not matched. Add them as extra items on the receipt if they were delivered.</p> : null}
              <div className="flex items-center justify-between">
                <Badge tone="info">AI-read · review required</Badge>
                <Button variant="primary" onClick={apply}>Apply to receipt (not saved yet)</Button>
              </div>
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
