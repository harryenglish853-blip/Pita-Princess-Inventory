/**
 * HTML email templates. Pure functions of the outbox payload (a data snapshot
 * taken when the email was queued), so what is sent can always be re-rendered
 * and previewed exactly. Tables + inline styles for mail clients; single column,
 * max 600px, large tap targets for phones. Every value is HTML-escaped.
 */
import Decimal from "decimal.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type OutboxRow = { id: string; kind: string; subject: string; payload: J };
export type Rendered = { subject: string; html: string; text: string };

// ---------------------------------------------------------------- formatting
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
const num = (v: unknown): Decimal | null => {
  if (v === null || v === undefined || v === "") return null;
  try { const d = new Decimal(String(v)); return d.isFinite() ? d : null; } catch { return null; }
};
export function fmtMoney(v: unknown): string {
  const d = num(v);
  if (!d) return "—";
  const s = d.abs().toDecimalPlaces(2).toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${d.isNegative() && !d.isZero() ? "-" : ""}$${s}`;
}
export function fmtPct(v: unknown, digits = 1): string {
  const d = num(v);
  return d ? `${d.toDecimalPlaces(digits).toFixed(digits)}%` : "—";
}
export function fmtPts(v: unknown): string {
  const d = num(v);
  if (!d) return "—";
  return `${d.gt(0) ? "+" : ""}${d.toDecimalPlaces(1).toFixed(1)} pts`;
}
export function fmtQty(v: unknown, unit?: string): string {
  const d = num(v);
  if (!d) return "—";
  return `${d.toDecimalPlaces(2).toNumber().toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ""}`;
}
export function fmtDate(v: unknown, opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" }): string {
  if (!v) return "—";
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { ...opts, timeZone: /^\d{4}-\d{2}-\d{2}$/.test(s) ? "UTC" : opts.timeZone });
}
/** Change between two numbers as "+$1,234.00 (+5.2%)". */
export function change(cur: unknown, prev: unknown): string {
  const c = num(cur), p = num(prev);
  if (!c || !p) return "—";
  const diff = c.minus(p);
  const pct = p.isZero() ? null : diff.div(p).times(100);
  return `${diff.gt(0) ? "+" : ""}${fmtMoney(diff)}${pct ? ` (${pct.gt(0) ? "+" : ""}${pct.toDecimalPlaces(1).toFixed(1)}%)` : ""}`;
}
const human = (s: string) => s.replace(/_/g, " ");

// ---------------------------------------------------------------- layout
const C = { brand: "#0f6e66", text: "#111827", muted: "#6b7280", border: "#e5e7eb", soft: "#f3f4f6", danger: "#b91c1c", warning: "#b45309" };

function stat(label: string, value: string, tone?: "danger" | "warning"): string {
  return `<td style="padding:10px 12px;border:1px solid ${C.border};border-radius:6px;width:50%;vertical-align:top">
    <div style="font-size:12px;color:${C.muted}">${esc(label)}</div>
    <div style="font-size:20px;font-weight:700;color:${tone ? C[tone] : C.text}">${esc(value)}</div></td>`;
}
function statGrid(items: [string, string, ("danger" | "warning")?][]): string {
  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 2) {
    const a = items[i], b = items[i + 1];
    rows.push(`<tr>${stat(a[0], a[1], a[2])}${b ? stat(b[0], b[1], b[2]) : "<td></td>"}</tr>`);
  }
  return `<table role="presentation" width="100%" cellspacing="6" cellpadding="0" style="border-collapse:separate">${rows.join("")}</table>`;
}
function section(title: string, body: string): string {
  return `<h2 style="margin:24px 0 8px;font-size:14px;letter-spacing:.06em;text-transform:uppercase;color:${C.brand}">${esc(title)}</h2>${body}`;
}
function list(rows: [string, string, string?][], empty = "None"): string {
  if (!rows.length) return `<p style="margin:0;color:${C.muted};font-size:14px">${esc(empty)}</p>`;
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:14px">${rows
    .map(([a, b, sub]) => `<tr><td style="padding:8px 0;border-bottom:1px solid ${C.border}">${esc(a)}${sub ? `<div style="font-size:12px;color:${C.muted}">${esc(sub)}</div>` : ""}</td>
      <td style="padding:8px 0;border-bottom:1px solid ${C.border};text-align:right;white-space:nowrap;font-weight:600">${esc(b)}</td></tr>`).join("")}</table>`;
}
function button(label: string, href: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:24px 0 8px"><tr><td style="background:${C.brand};border-radius:6px">
    <a href="${esc(href)}" style="display:inline-block;padding:14px 22px;color:#ffffff;font-weight:700;text-decoration:none;font-size:15px">${esc(label)}</a></td></tr></table>`;
}
function shell(title: string, subtitle: string, body: string, footer: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;background:${C.soft};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.text}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid ${C.border};border-radius:8px">
<tr><td style="padding:20px 20px 4px"><div style="font-size:12px;color:${C.muted};text-transform:uppercase;letter-spacing:.06em">${esc(subtitle)}</div>
<h1 style="margin:4px 0 0;font-size:22px;line-height:1.25">${esc(title)}</h1></td></tr>
<tr><td style="padding:4px 20px 20px">${body}</td></tr></table>
<p style="max-width:600px;font-size:12px;color:${C.muted};margin:12px auto">${esc(footer)}</p></td></tr></table></body></html>`;
}
const where = (p: J) => (p.location ? `#${p.location.code} ${p.location.name}` : p.organization ?? "");
const footerText = (p: J) => `${p.organization ?? "Stockline"} · You receive this because you are subscribed in Administration → Email.`;

// ---------------------------------------------------------------- templates
function daily(p: J, url: string): { html: string; text: string } {
  const attention = (p.attention ?? []) as J[];
  const issues = (p.delivery_issue_list ?? []) as J[];
  const body = statGrid([
    ["Sales", p.sales == null ? "Not imported" : fmtMoney(p.sales)],
    ["Waste", fmtMoney(p.waste), Number(p.waste) > 0 ? "warning" : undefined],
    ["Deliveries", String(p.deliveries ?? 0)],
    ["Delivery issues", String(p.delivery_issues ?? 0), Number(p.delivery_issues) ? "danger" : undefined],
    ["Low stock", String(p.low_stock ?? 0), Number(p.low_stock) ? "warning" : undefined],
    ["Critical / out", String(p.critical_stock ?? 0), Number(p.critical_stock) ? "danger" : undefined],
    ["Theoretical food cost", p.theoretical_pct == null ? "—" : fmtPct(p.theoretical_pct)],
    ["Commissary received", p.commissary ? String(p.commissary.received ?? 0) : "0"],
  ]) + section("Needs attention", list(attention.map((a) => [a.title, human(String(a.severity ?? "")).toUpperCase(), a.message]), "Nothing needs attention."))
    + (issues.length ? section("Delivery discrepancies", list(issues.map((i) => [`${i.vendor} ${i.invoice_number ? `invoice #${i.invoice_number}` : i.receipt_number}`, "", human(String(i.issues ?? ""))]))) : "")
    + `<p style="font-size:12px;color:${C.muted}">Theoretical food cost is yesterday's menu items sold × current recipe cost. Actual food cost needs posted counts and is in the weekly report.</p>`
    + button("VIEW DASHBOARD", `${url}/`);
  const text = [`Daily operations — ${fmtDate(p.date)} — ${where(p)}`, `Sales: ${p.sales == null ? "Not imported" : fmtMoney(p.sales)}`, `Waste: ${fmtMoney(p.waste)}`,
    `Deliveries: ${p.deliveries ?? 0}`, `Delivery issues: ${p.delivery_issues ?? 0}`, `Low stock: ${p.low_stock ?? 0}`, `Critical: ${p.critical_stock ?? 0}`,
    `Theoretical food cost: ${p.theoretical_pct == null ? "—" : fmtPct(p.theoretical_pct)}`, "", "NEEDS ATTENTION",
    ...(attention.length ? attention.map((a) => `- ${a.title}${a.message ? `: ${a.message}` : ""}`) : ["- Nothing"]), "", `View dashboard: ${url}/`].join("\n");
  return { html: shell(`Daily Restaurant Operations — ${fmtDate(p.date, { month: "long", day: "numeric" })}`, where(p), body, footerText(p)), text };
}

function period(p: J, url: string, monthly: boolean): { html: string; text: string } {
  const fc = (p.food_cost ?? {}) as J;
  const vs = (p.vendor_spending ?? []) as J[];
  const label = monthly ? fmtDate(`${p.month}-15`, { month: "long", year: "numeric" }) : `${fmtDate(p.from, { month: "short", day: "numeric" })} – ${fmtDate(p.to, { month: "short", day: "numeric" })}`;
  const variancePts = fc.variance_pct_points;
  const wastePct = num(p.sales)?.gt(0) ? new Decimal(String(p.waste ?? 0)).div(String(p.sales)).times(100) : null;
  let body = statGrid([
    ["Sales", fmtMoney(p.sales)],
    ["Purchases", fmtMoney(p.purchases)],
    ["Beginning inventory", fmtMoney(fc.begin_inventory)],
    ["Ending inventory", fmtMoney(fc.end_inventory)],
    ["Actual food cost", fc.actual_pct == null ? "—" : `${fmtPct(fc.actual_pct)} · ${fmtMoney(fc.actual_cost)}`],
    ["Theoretical food cost", fc.theoretical_pct == null ? "—" : `${fmtPct(fc.theoretical_pct)} · ${fmtMoney(fc.theoretical_cost)}`],
    ["Variance (AvT)", variancePts == null ? fmtMoney(fc.variance) : `${fmtPts(variancePts)} · ${fmtMoney(fc.variance)}`, num(variancePts)?.gt(0) ? "danger" : undefined],
    ["Waste", `${fmtMoney(p.waste)}${wastePct ? ` · ${fmtPct(wastePct)}` : ""}`],
    ["Inventory variance (counts)", fmtMoney(p.inventory_variance), num(p.inventory_variance)?.lt(0) ? "danger" : undefined],
    ...(monthly ? [["Inventory turnover", p.turnover == null ? "—" : `${p.turnover}×`] as [string, string]] : []),
  ]);
  body += `<p style="font-size:12px;color:${C.muted}">${fc.basis === "count_to_count"
    ? `Food cost runs count to count: ${esc(fc.begin_count)} → ${esc(fc.end_count)}.`
    : "No posted count brackets this period, so beginning/ending inventory are book (perpetual) values."} Actual = beginning + purchases + transfers − ending.</p>`;
  if (monthly && p.previous) {
    const pr = p.previous as J;
    body += section("Month over month", list([
      ["Sales", change(p.sales, pr.sales)], ["Purchases", change(p.purchases, pr.purchases)], ["Waste", change(p.waste, pr.waste)],
      ["Actual food cost", pr.actual_pct == null || fc.actual_pct == null ? "—" : fmtPts(new Decimal(String(fc.actual_pct)).minus(String(pr.actual_pct)))],
      ["Theoretical food cost", pr.theoretical_pct == null || fc.theoretical_pct == null ? "—" : fmtPts(new Decimal(String(fc.theoretical_pct)).minus(String(pr.theoretical_pct)))],
    ]));
    const weeks = ((p.weeks ?? []) as J[]).filter((w) => w.food_cost?.actual_pct != null);
    if (weeks.length) {
      const sorted = [...weeks].sort((a, b) => Number(a.food_cost.variance_pct_points ?? 0) - Number(b.food_cost.variance_pct_points ?? 0));
      body += section("Best and worst weeks (AvT gap)", list(sorted.map((w, i) => [
        `${fmtDate(w.from, { month: "short", day: "numeric" })} – ${fmtDate(w.to, { month: "short", day: "numeric" })}${i === 0 ? " · best" : i === sorted.length - 1 && sorted.length > 1 ? " · worst" : ""}`,
        `${fmtPct(w.food_cost.actual_pct)} vs ${fmtPct(w.food_cost.theoretical_pct)}`, `Sales ${fmtMoney(w.sales)}`])));
    }
    body += section("Vendor price trends", list(((p.price_trends ?? []) as J[]).map((t) => [`${t.product}${t.vendor ? ` · ${t.vendor}` : ""}`,
      `${num(t.pct)?.gt(0) ? "+" : ""}${fmtPct(t.pct)}`, `${fmtMoney(t.first)} → ${fmtMoney(t.last)} per ${t.unit}`]), "No price changes this month."));
  }
  body += section(monthly ? "Top loss products" : "Top inventory variances", list(((p.top_variances ?? []) as J[]).map((v) => [v.name, fmtMoney(v.value), fmtQty(v.qty, v.unit)]), "No count losses."));
  body += section("Top waste", list(((p.top_waste ?? []) as J[]).map((w) => [w.name, fmtMoney(w.cost)]), "No waste logged."));
  body += section("Vendor spending", list(vs.map((v) => [v.vendor, fmtMoney(v.total), `${v.deliveries} deliver${Number(v.deliveries) === 1 ? "y" : "ies"}`]), "No posted invoices."));
  if (!monthly) {
    body += section("Price alerts", list(((p.price_alerts ?? []) as J[]).map((a) => [String(a.title).replace(/^Price increase: /, ""), "", a.message]), "No price increases."));
    body += section("Delivery discrepancies", list(((p.delivery_discrepancies ?? []) as J[]).map((d) => [`${d.vendor} ${d.invoice_number ? `#${d.invoice_number}` : d.receipt_number}`,
      fmtDate(d.delivery_date), human(String(d.issues ?? ""))]), "None."));
    body += section("Low stock", list(((p.low_stock ?? []) as J[]).slice(0, 15).map((s) => [s.name, fmtQty(s.on_hand, s.unit), human(String(s.status)).toUpperCase()]), "Nothing low."));
    body += section("Inventory completion", list(((p.counts ?? []) as J[]).map((c) => [c.name, human(String(c.status)).toUpperCase(), fmtDate(c.count_at)]), "No count in this period."));
  }
  if (p.commissary) body += section("Commissary", list([["Orders received", String(p.commissary.received ?? 0)], ["Value received", fmtMoney(p.commissary.value)],
    ["Orders with differences", String(p.commissary.discrepancies ?? 0)]]));
  body += button("VIEW FULL REPORT", `${url}/food-cost`);
  const text = [`${monthly ? "Monthly owner report" : "Weekly inventory report"} — ${label} — ${where(p)}`,
    `Sales: ${fmtMoney(p.sales)}`, `Purchases: ${fmtMoney(p.purchases)}`, `Beginning inventory: ${fmtMoney(fc.begin_inventory)}`, `Ending inventory: ${fmtMoney(fc.end_inventory)}`,
    `Waste: ${fmtMoney(p.waste)}`, `Actual food cost: ${fmtPct(fc.actual_pct)} (${fmtMoney(fc.actual_cost)})`, `Theoretical: ${fmtPct(fc.theoretical_pct)} (${fmtMoney(fc.theoretical_cost)})`,
    `Variance: ${fmtPts(variancePts)} (${fmtMoney(fc.variance)})`, "", "VENDOR SPENDING", ...vs.map((v) => `- ${v.vendor}: ${fmtMoney(v.total)}`),
    "", `View full report: ${url}/food-cost`].join("\n");
  return { html: shell(monthly ? `Monthly Owner Report — ${label}` : `Weekly Restaurant Inventory Report — ${label}`, where(p), body, footerText(p)), text };
}

function alert(p: J, url: string): { html: string; text: string } {
  const link = typeof p.link === "string" && p.link.startsWith("/") ? p.link
    : p.entity_type === "receipt" && p.entity_id ? `/receiving/${p.entity_id}`
    : p.entity_type === "commissary_order" && p.entity_id ? `/commissary/${p.entity_id}`
    : p.entity_type === "count_session" && p.entity_id ? `/counts/${p.entity_id}/review`
    : p.product_id ? `/inventory/items/${p.product_id}` : "/tasks";
  const tone = p.severity === "critical" ? C.danger : C.warning;
  const body = `<div style="border-left:4px solid ${tone};padding:8px 12px;background:${C.soft};border-radius:4px">
      <div style="font-size:12px;font-weight:700;color:${tone};text-transform:uppercase">${esc(human(String(p.alert_type ?? p.severity ?? "alert")))}</div>
      <div style="font-size:17px;font-weight:700;margin-top:2px">${esc(p.title)}</div>
      ${p.message ? `<div style="font-size:14px;margin-top:4px">${esc(p.message)}</div>` : ""}</div>`
    + (Array.isArray(p.data?.issues) ? section("Details", list((p.data.issues as J[]).map((i) => [i.product, `${fmtQty(i.received)} of ${fmtQty(i.ordered)}`, `Shipped ${fmtQty(i.shipped)} · value ${fmtMoney(i.value)}`]))) : "")
    + button("OPEN IN STOCKLINE", `${url}${link}`);
  return { html: shell(String(p.title ?? "Alert"), where(p), body, footerText(p)), text: `${p.title}\n${p.message ?? ""}\n\n${where(p)}\nOpen: ${url}${link}` };
}

function stock(p: J, url: string): { html: string; text: string } {
  const items = (p.items ?? []) as J[];
  const title = p.level === "critical" ? "Critical stock" : "Low stock";
  const body = `<p style="font-size:14px;margin:0 0 8px">${items.length} item${items.length === 1 ? "" : "s"} ${p.level === "critical" ? "at or below minimum, or out" : "below the reorder point"} as of ${esc(fmtDate(p.date))}.</p>`
    + list(items.map((i) => [i.name, fmtQty(i.on_hand, i.unit), `${human(String(i.status)).toUpperCase()}${i.par != null ? ` · par ${fmtQty(i.par, i.unit)}` : ""}`]))
    + button("ORDERING CENTER", `${url}/ordering`);
  return { html: shell(title, where(p), body, footerText(p)), text: [`${title} — ${where(p)}`, ...items.map((i) => `- ${i.name}: ${fmtQty(i.on_hand, i.unit)} (${i.status})`), `Ordering: ${url}/ordering`].join("\n") };
}

function commissary(p: J, url: string): { html: string; text: string } {
  const lines = (p.lines ?? []) as J[];
  const body = statGrid([["Restaurant", `#${p.restaurant}`], ["Needed", fmtDate(p.needed_date, { weekday: "long", month: "short", day: "numeric" })]])
    + section("Items", list(lines.map((l) => [l.name, `${fmtQty(l.qty)} ${l.unit}`, l.notes ?? undefined])))
    + (p.notes ? section("Notes", `<p style="margin:0;font-size:14px">${esc(p.notes)}</p>`) : "")
    + `<p style="font-size:12px;color:${C.muted}">Submitted by ${esc(p.submitted_by ?? "—")} · ${esc(p.order_number)}</p>`
    + button("VIEW ORDER", `${url}${typeof p.link === "string" && p.link.startsWith("/") ? p.link : "/commissary"}`);
  const text = [`COMMISSARY ORDER ${p.order_number}`, `Restaurant: #${p.restaurant}`, `Needed: ${fmtDate(p.needed_date, { weekday: "long", month: "short", day: "numeric" })}`, "",
    ...lines.map((l) => `${l.name} — ${fmtQty(l.qty)} ${l.unit}`), p.notes ? `\nNotes: ${p.notes}` : "", `\nView order: ${url}${p.link ?? "/commissary"}`].join("\n");
  return { html: shell(`Commissary Order ${p.order_number}`, String(p.commissary ?? "Commissary"), body, footerText(p)), text };
}

export function renderEmail(row: OutboxRow, appUrl: string): Rendered {
  const url = appUrl.replace(/\/+$/, "");
  const p = row.payload ?? {};
  const t = p.template as string | undefined;
  const r = t === "daily" ? daily(p, url)
    : t === "weekly" ? period(p, url, false)
    : t === "monthly" ? period(p, url, true)
    : t === "stock" ? stock(p, url)
    : t === "commissary_order" ? commissary(p, url)
    : alert(p, url);
  return { subject: row.subject, ...r };
}
