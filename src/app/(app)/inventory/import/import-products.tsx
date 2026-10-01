"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { Download, FileUp } from "lucide-react";
import { Badge, Button, Card, Notice, Textarea } from "@/components/ui";
import { useToast } from "@/components/client";
import { downloadFile } from "@/lib/csv";
import { PRODUCT_COLUMNS, parseProductSheet, productTemplateCsv } from "@/lib/import/products";
import { importProducts, type ImportReport } from "../actions";

/** Spreadsheet → preview (nothing saved) → import. */
export function ImportProducts() {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const parsed = useMemo(() => parseProductSheet(text), [text]);
  const missing = PRODUCT_COLUMNS.filter((c) => "required" in c && c.required && !parsed.columns.some((p) => p.key === c.key));

  const run = (apply: boolean) => start(async () => {
    const r = await importProducts(parsed.rows as Record<string, string>[], apply);
    if (!r?.ok) { toast({ tone: "error", text: r?.error ?? "Import failed" }); return; }
    setReport(r.data!);
    if (apply) toast({ tone: "success", text: r.message! });
  });
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    if (/\.(xlsx|xls|numbers)$/i.test(f.name)) {
      toast({ tone: "error", text: "Save the sheet as CSV first (File → Download/Save as → CSV), or copy the cells and paste them below." });
      return;
    }
    setFileName(f.name); setReport(null); setText(await f.text());
  };

  return (
    <div className="space-y-4">
      <Card title="1. Get your list into this layout">
        <div className="space-y-3 text-sm">
          <p>Use the template, or your own sheet with similar column names (a Sysco or Greco order-guide export usually works). Only <b>Item name</b> and <b>Count unit</b> are required.</p>
          <Button size="sm" onClick={() => downloadFile("products-template.csv", productTemplateCsv(), "text/csv;charset=utf-8")}><Download className="h-4 w-4" /> Download template</Button>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Column</th><th>What to put in it</th></tr></thead>
              <tbody>{PRODUCT_COLUMNS.map((c) => <tr key={c.key}><td className="whitespace-nowrap font-medium">{c.label}{"required" in c && c.required ? " *" : ""}</td><td className="text-muted">{c.help}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      </Card>

      <Card title="2. Upload the CSV or paste the cells">
        <div className="space-y-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-strong px-3 py-2 text-sm">
            <FileUp className="h-4 w-4" /> {fileName ?? "Choose a CSV file"}
            <input type="file" accept=".csv,text/csv,.xlsx,.xls" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <Textarea aria-label="Paste spreadsheet cells" rows={6} value={text} onChange={(e) => { setText(e.target.value); setFileName(null); setReport(null); }}
            placeholder={"…or copy the cells in Excel / Google Sheets, including the header row, and paste here"} className="font-mono text-xs" />
          {parsed.columns.length ? (
            <div className="flex flex-wrap gap-1.5 text-xs" data-testid="column-map">
              {parsed.columns.map((c, i) => c.key
                ? <Badge key={i} tone="success">{c.header} → {PRODUCT_COLUMNS.find((x) => x.key === c.key)!.label}</Badge>
                : <Badge key={i}>{c.header || "(blank)"}: ignored</Badge>)}
            </div>
          ) : null}
          {parsed.columns.length && missing.length ? <Notice tone="warning" title="Missing columns">Add a column for: {missing.map((m) => m.label).join(", ")}.</Notice> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => run(false)} disabled={pending || !parsed.rows.length || missing.length > 0}>
              {pending && !report ? "Checking…" : `Preview ${parsed.rows.length || ""} item${parsed.rows.length === 1 ? "" : "s"}`}
            </Button>
            <span className="text-xs text-muted">Preview checks every row and saves nothing.</span>
          </div>
        </div>
      </Card>

      {report ? (
        <Card title={report.applied ? "Imported" : "3. Check the preview, then import"}>
          <div className="space-y-3 text-sm">
            {report.applied ? <Notice tone="success" title="Done">Your items are in. Next: put them in walking order under <Link className="text-brand underline" href="/inventory/storage">Storage &amp; shelf order</Link>, then start your first count.</Notice> : null}
            <div className="flex flex-wrap gap-2" data-testid="import-summary">
              <Badge tone="success">{report.summary.create} new</Badge>
              <Badge tone="info">{report.summary.update} updated</Badge>
              {report.summary.skip ? <Badge tone="danger">{report.summary.skip} with problems (skipped)</Badge> : null}
            </div>
            {[["New categories", report.summary.categories], ["New vendors", report.summary.vendors], ["New storage areas", report.summary.storage_areas]].map(([k, v]) =>
              (v as string[]).length ? <p key={k as string}><span className="text-muted">{k as string}{report.applied ? "" : " to create"}:</span> {(v as string[]).join(", ")}</p> : null)}
            <div className="max-h-[28rem] overflow-auto rounded border border-border">
              <table className="tbl">
                <thead><tr><th className="num">Row</th><th>Item</th><th>Result</th><th>Notes</th></tr></thead>
                <tbody>{report.rows.map((r) => (
                  <tr key={r.row} className={r.action === "skip" ? "bg-danger-soft/40" : undefined}>
                    <td className="num">{r.row + 1}</td>
                    <td>{r.name || <span className="text-muted">(no name)</span>}{r.item_number ? <span className="text-xs text-muted"> #{r.item_number}</span> : null}</td>
                    <td><Badge tone={r.action === "create" ? "success" : r.action === "update" ? "info" : "danger"}>{r.action === "create" ? "New" : r.action === "update" ? "Update" : "Skipped"}</Badge></td>
                    <td className="text-xs">{[...r.errors.map((e) => <div key={e} className="text-danger">{e}</div>), ...r.warnings.map((w) => <div key={w} className="text-warning">{w}</div>)]}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="text-xs text-muted">Row numbers match your spreadsheet (row 1 is the header).</p>
            {!report.applied ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" onClick={() => run(true)} disabled={pending || report.summary.create + report.summary.update === 0}>
                  {pending ? "Importing…" : `Import ${report.summary.create + report.summary.update} item${report.summary.create + report.summary.update === 1 ? "" : "s"}`}
                </Button>
                {report.summary.skip ? <span className="text-xs text-muted">Rows with problems are skipped. Fix them in the sheet and import again any time; nothing is duplicated.</span> : null}
              </div>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
