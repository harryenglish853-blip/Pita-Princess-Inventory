"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { money, pct, qty, dateFmt, dateTimeFmt, titleCase } from "@/lib/format";
import { toCsv, downloadFile } from "@/lib/csv";
import { Badge, Button, cx, inputBase } from "./ui";

export type ColumnFormat = "text" | "number" | "money" | "money4" | "qty" | "signedQty" | "pct" | "date" | "datetime" | "status" | "bool";

export type Column = {
  key: string;
  label: string;
  format?: ColumnFormat;
  /** Unit column key appended to qty values (e.g. "inventory_unit"). */
  unitKey?: string;
  /** Link template, e.g. "/inventory/items/{product_id}". */
  href?: string;
  filterable?: boolean;
  hidden?: boolean;
  /** Tone rule for numbers: negative values shown red. */
  negativeRed?: boolean;
  total?: boolean;
  className?: string;
};

type View = { name: string; search: string; filters: Record<string, string>; sort: { key: string; dir: 1 | -1 } | null; hidden: string[]; groupBy: string };

const PAGE = 200;

function fill(tpl: string, row: Record<string, unknown>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(String(row[k] ?? "")));
}

function render(col: Column, row: Record<string, unknown>) {
  const v = row[col.key];
  const unit = col.unitKey ? (row[col.unitKey] as string) : undefined;
  switch (col.format) {
    case "money": return money(v as number);
    case "money4": return money(v as number, { precise: true });
    case "qty": return qty(v as number, unit);
    case "signedQty": return v === null || v === undefined ? "—" : `${Number(v) > 0 ? "+" : ""}${qty(v as number, unit)}`;
    case "number": return v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 2 });
    case "pct": return pct(v as number);
    case "date": return dateFmt(v as string);
    case "datetime": return dateTimeFmt(v as string);
    case "bool": return v ? "Yes" : "No";
    case "status": {
      const s = String(v ?? "");
      const tone = ({ ok: "success", low: "warning", critical: "danger", out: "danger", negative: "danger" } as const)[s as "ok"] ?? "neutral";
      return s ? <Badge tone={tone}>{titleCase(s)}</Badge> : "—";
    }
    default: return v === null || v === undefined || v === "" ? "—" : String(v);
  }
}

const isNumeric = (f?: ColumnFormat) => !!f && ["number", "money", "money4", "qty", "signedQty", "pct"].includes(f);

/**
 * Operational data table: search, sort, filters, grouping, show/hide columns,
 * saved views (per browser), CSV / Excel export, print-to-PDF. Paginates in
 * blocks of 200 rows to stay fast on large inventories.
 */
export function DataTable({ id, columns, rows, searchKeys, emptyText = "No records", initialSort, exportName, dense }: {
  id: string; columns: Column[]; rows: Record<string, unknown>[]; searchKeys?: string[]; emptyText?: string;
  initialSort?: { key: string; dir: 1 | -1 }; exportName?: string; dense?: boolean;
}) {
  const storageKey = `table:${id}`;
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(initialSort ?? null);
  const [hidden, setHidden] = useState<string[]>(columns.filter((c) => c.hidden).map((c) => c.key));
  const [groupBy, setGroupBy] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [views, setViews] = useState<View[]>([]);
  const [showCols, setShowCols] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw) as { current?: View; views?: View[] };
        if (saved.views) setViews(saved.views);
        if (saved.current) apply(saved.current);
      }
    } catch { /* ignore corrupt storage */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ views, current: { name: "current", search: "", filters, sort, hidden, groupBy } }));
    } catch { /* storage full or disabled */ }
  }, [storageKey, views, filters, sort, hidden, groupBy]);

  function apply(v: View) {
    setSearch(v.search ?? ""); setFilters(v.filters ?? {}); setSort(v.sort ?? null); setHidden(v.hidden ?? []); setGroupBy(v.groupBy ?? "");
  }

  const visibleCols = columns.filter((c) => !hidden.includes(c.key));
  const filterCols = columns.filter((c) => c.filterable);
  const filterOptions = useMemo(() => {
    const o: Record<string, string[]> = {};
    for (const c of filterCols) o[c.key] = Array.from(new Set(rows.map((r) => String(r[c.key] ?? "")).filter(Boolean))).sort();
    return o;
  }, [rows, filterCols]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const keys = searchKeys ?? columns.filter((c) => !isNumeric(c.format)).map((c) => c.key);
    let out = rows.filter((r) => {
      for (const [k, v] of Object.entries(filters)) if (v && String(r[k] ?? "") !== v) return false;
      if (!q) return true;
      return keys.some((k) => String(r[k] ?? "").toLowerCase().includes(q));
    });
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      const numeric = isNumeric(col?.format);
      out = [...out].sort((a, b) => {
        const av = a[sort.key]; const bv = b[sort.key];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return (numeric ? Number(av) - Number(bv) : String(av).localeCompare(String(bv))) * sort.dir;
      });
    }
    return out;
  }, [rows, search, filters, sort, columns, searchKeys]);

  const groups = useMemo(() => {
    if (!groupBy) return [{ key: "", rows: filtered }];
    const m = new Map<string, Record<string, unknown>[]>();
    for (const r of filtered.slice(0, limit)) {
      const k = String(r[groupBy] ?? "—");
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m, ([key, rows]) => ({ key, rows }));
  }, [filtered, groupBy, limit]);

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    for (const c of columns) if (c.total) t[c.key] = filtered.reduce((s, r) => s + (Number(r[c.key]) || 0), 0);
    return t;
  }, [filtered, columns]);
  const hasTotals = Object.keys(totals).length > 0;

  function exportCsv(excel: boolean) {
    const cols = visibleCols;
    const data = filtered.map((r) => cols.map((c) => r[c.key] as string | number | null));
    const csv = toCsv(cols.map((c) => c.label), data);
    const name = `${exportName ?? id}-${new Date().toISOString().slice(0, 10)}`;
    if (excel) downloadFile(`${name}.xls.csv`, "﻿" + csv, "application/vnd.ms-excel;charset=utf-8");
    else downloadFile(`${name}.csv`, csv, "text/csv;charset=utf-8");
  }

  function saveView() {
    const name = window.prompt("Name this view");
    if (!name) return;
    setViews((v) => [...v.filter((x) => x.name !== name), { name, search, filters, sort, hidden, groupBy }]);
  }

  const cell = dense ? "py-1.5" : "";

  return (
    <div className="rounded-lg border border-border bg-surface">
      <div className="no-print flex flex-wrap items-center gap-2 border-b border-border p-2">
        <input
          type="search" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(PAGE); }}
          placeholder="Search…" aria-label="Search table" className={cx(inputBase, "h-9 w-full sm:w-64")}
        />
        {filterCols.map((c) => (
          <select key={c.key} aria-label={`Filter ${c.label}`} value={filters[c.key] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))}
            className={cx(inputBase, "h-9 max-w-44")}>
            <option value="">All {c.label.toLowerCase()}</option>
            {filterOptions[c.key]?.map((o) => <option key={o} value={o}>{titleCase(o)}</option>)}
          </select>
        ))}
        <select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value)} className={cx(inputBase, "h-9")}>
          <option value="">No grouping</option>
          {columns.filter((c) => !isNumeric(c.format)).map((c) => <option key={c.key} value={c.key}>Group: {c.label}</option>)}
        </select>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {views.length > 0 ? (
            <select aria-label="Saved views" defaultValue="" onChange={(e) => { const v = views.find((x) => x.name === e.target.value); if (v) apply(v); e.target.value = ""; }}
              className={cx(inputBase, "h-9")}>
              <option value="">Saved views…</option>
              {views.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
            </select>
          ) : null}
          <Button size="sm" variant="ghost" onClick={saveView}>Save view</Button>
          <div className="relative">
            <Button size="sm" variant="ghost" onClick={() => setShowCols((s) => !s)} aria-expanded={showCols}>Columns</Button>
            {showCols ? (
              <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-border bg-surface p-2 shadow-lg">
                {columns.map((c) => (
                  <label key={c.key} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
                    <input type="checkbox" checked={!hidden.includes(c.key)} onChange={(e) => setHidden((h) => (e.target.checked ? h.filter((x) => x !== c.key) : [...h, c.key]))} />
                    {c.label}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
          <Button size="sm" variant="ghost" onClick={() => exportCsv(false)}>CSV</Button>
          <Button size="sm" variant="ghost" onClick={() => exportCsv(true)}>Excel</Button>
          <Button size="sm" variant="ghost" onClick={() => window.print()}>Print / PDF</Button>
        </div>
      </div>
      <div className="print-full max-h-[70vh] overflow-auto">
        <table className="tbl">
          <thead>
            <tr>
              {visibleCols.map((c) => (
                <th key={c.key} className={cx(isNumeric(c.format) && "num", c.className)}>
                  <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-text"
                    onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: isNumeric(c.format) ? -1 : 1 }))}>
                    {c.label}
                    {sort?.key === c.key ? <span aria-hidden>{sort.dir === 1 ? "▲" : "▼"}</span> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={visibleCols.length} className="py-10 text-center text-muted">{emptyText}</td></tr>
            ) : groups.map((g) => (
              <GroupRows key={g.key} group={g} groupBy={groupBy} cols={visibleCols} cell={cell} limit={groupBy ? Infinity : limit} />
            ))}
          </tbody>
          {hasTotals && filtered.length > 0 ? (
            <tfoot>
              <tr className="font-semibold">
                {visibleCols.map((c, i) => (
                  <td key={c.key} className={cx("border-t-2 border-border-strong bg-surface-2", isNumeric(c.format) && "num")}>
                    {i === 0 ? `Total (${filtered.length})` : c.total ? render(c, { [c.key]: totals[c.key] }) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <div className="no-print flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted">
        <span>{Math.min(limit, filtered.length)} of {filtered.length} shown{filtered.length !== rows.length ? ` (filtered from ${rows.length})` : ""}</span>
        {filtered.length > limit ? <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + PAGE)}>Show more</Button> : null}
      </div>
    </div>
  );
}

function GroupRows({ group, groupBy, cols, cell, limit }: { group: { key: string; rows: Record<string, unknown>[] }; groupBy: string; cols: Column[]; cell: string; limit: number }) {
  return (
    <>
      {groupBy ? (
        <tr><td colSpan={cols.length} className="bg-surface-2 text-xs font-semibold uppercase tracking-wide text-muted">{titleCase(group.key)} · {group.rows.length}</td></tr>
      ) : null}
      {group.rows.slice(0, limit).map((r, i) => (
        <tr key={String(r.id ?? r.product_id ?? i) + i}>
          {cols.map((c) => {
            const content = render(c, r);
            const neg = c.negativeRed && Number(r[c.key]) < 0;
            return (
              <td key={c.key} className={cx(cell, isNumeric(c.format) && "num", neg && "text-danger", c.className)}>
                {c.href ? <Link className="font-medium text-brand hover:underline" href={fill(c.href, r)}>{content}</Link> : content}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
