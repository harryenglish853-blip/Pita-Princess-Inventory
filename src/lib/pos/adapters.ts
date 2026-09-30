import { money, toRecords } from "./csv-parse";

/**
 * POS integration layer. Every adapter normalizes its source into NormalizedSales;
 * the database only ever sees this neutral shape (import_sales RPC), so adding a POS
 * never changes inventory logic. File adapters parse exports today; API adapters
 * declare what they need and are enabled when credentials are configured server-side.
 */
export type SalesLine = { pos_item_id: string | null; item_name: string; quantity: number; net_sales: number; discounts: number; voids: number; refunds: number; daypart: string | null };
export type NormalizedSales = {
  summary: { net_sales: number; gross_sales: number; discounts: number; voids: number; refunds: number; guest_count: number; check_count: number };
  lines: SalesLine[];
  warnings: string[];
};

export type PosAdapter = {
  id: "csv" | "toast" | "square" | "clover" | "micros" | "aloha" | "lightspeed";
  name: string;
  kind: "file" | "api";
  description: string;
  parse?: (text: string) => NormalizedSales;
};

function pick(r: Record<string, string>, ...keys: string[]) {
  for (const k of keys) if (r[k] !== undefined && r[k] !== "") return r[k];
  return "";
}

function aggregate(lines: SalesLine[], warnings: string[]): NormalizedSales {
  const byKey = new Map<string, SalesLine>();
  for (const l of lines) {
    const k = (l.pos_item_id ?? "") + "|" + l.item_name.toLowerCase();
    const e = byKey.get(k);
    if (e) { e.quantity += l.quantity; e.net_sales += l.net_sales; e.discounts += l.discounts; e.voids += l.voids; e.refunds += l.refunds; }
    else byKey.set(k, { ...l });
  }
  const out = [...byKey.values()].map((l) => ({ ...l, quantity: Math.round(l.quantity * 100) / 100, net_sales: Math.round(l.net_sales * 100) / 100 }));
  const sum = (f: (l: SalesLine) => number) => Math.round(out.reduce((s, l) => s + f(l), 0) * 100) / 100;
  return {
    summary: { net_sales: sum((l) => l.net_sales), gross_sales: sum((l) => l.net_sales + l.discounts), discounts: sum((l) => l.discounts), voids: sum((l) => l.voids), refunds: sum((l) => l.refunds), guest_count: 0, check_count: 0 },
    lines: out, warnings,
  };
}

/** Generic CSV: item_id,item_name,quantity,net_sales[,discounts,voids,refunds,daypart] */
function parseGeneric(text: string): NormalizedSales {
  const warnings: string[] = [];
  const recs = toRecords(text);
  if (!recs.length) throw new Error("The file has no rows");
  if (!("item_name" in recs[0]) && !("item_id" in recs[0])) throw new Error("Expected columns: item_id, item_name, quantity, net_sales");
  const lines = recs.map((r, i) => {
    const q = Number(pick(r, "quantity", "qty"));
    if (!Number.isFinite(q)) warnings.push(`Row ${i + 2}: quantity is not a number`);
    return { pos_item_id: pick(r, "item_id", "pos_item_id", "plu") || null, item_name: pick(r, "item_name", "name", "item") || pick(r, "item_id"),
             quantity: Number.isFinite(q) ? q : 0, net_sales: money(pick(r, "net_sales", "sales", "amount")), discounts: money(r.discounts),
             voids: Number(r.voids || 0) || 0, refunds: money(r.refunds), daypart: r.daypart || null };
  });
  return aggregate(lines, warnings);
}

/** Toast "Item Selection Details" export (one row per item selection). */
function parseToast(text: string): NormalizedSales {
  const warnings: string[] = [];
  const recs = toRecords(text);
  if (!recs.length || !("menu item" in recs[0])) throw new Error("This does not look like a Toast Item Selection Details export (missing 'Menu Item' column)");
  const lines: SalesLine[] = [];
  let voided = 0;
  for (const r of recs) {
    const isVoid = /^(true|yes|1)$/i.test(pick(r, "void?", "void", "voided"));
    const qty = Number(pick(r, "qty", "quantity") || 1);
    if (isVoid) { voided += qty; lines.push({ pos_item_id: pick(r, "item id", "menu item guid", "plu") || null, item_name: r["menu item"], quantity: 0, net_sales: 0, discounts: 0, voids: qty, refunds: 0, daypart: null }); continue; }
    lines.push({
      pos_item_id: pick(r, "item id", "menu item guid", "plu") || null, item_name: r["menu item"], quantity: qty,
      net_sales: money(pick(r, "net price", "net amount")), discounts: money(pick(r, "discount amount", "discount")),
      voids: 0, refunds: 0, daypart: pick(r, "dining option", "service period") || null,
    });
  }
  if (voided) warnings.push(`${voided} voided item(s) recorded as voids and not depleted`);
  return aggregate(lines, warnings);
}

/** Square "Item Sales" export. */
function parseSquare(text: string): NormalizedSales {
  const recs = toRecords(text);
  if (!recs.length || !("items sold" in recs[0] || "item" in recs[0])) throw new Error("This does not look like a Square Item Sales export (missing 'Item' / 'Items Sold')");
  const lines = recs.filter((r) => r.item).map((r) => ({
    pos_item_id: pick(r, "sku", "token") || null,
    item_name: r["item variation"] && !/^regular$/i.test(r["item variation"]) ? `${r.item} (${r["item variation"]})` : r.item,
    quantity: Number(pick(r, "items sold", "qty") || 0), net_sales: money(pick(r, "net sales")), discounts: Math.abs(money(r.discounts)),
    voids: 0, refunds: Math.abs(money(pick(r, "refunds", "returns"))), daypart: null,
  }));
  return aggregate(lines, []);
}

export const POS_ADAPTERS: PosAdapter[] = [
  { id: "csv", name: "Generic CSV", kind: "file", description: "Columns: item_id, item_name, quantity, net_sales (optional: discounts, voids, refunds, daypart)", parse: parseGeneric },
  { id: "toast", name: "Toast", kind: "file", description: "Upload the 'Item Selection Details' CSV export from Toast Web", parse: parseToast },
  { id: "square", name: "Square", kind: "file", description: "Upload the 'Item Sales' CSV export from Square Dashboard", parse: parseSquare },
  { id: "clover", name: "Clover", kind: "api", description: "API connection (requires Clover app credentials). Until connected, export item sales as CSV and use Generic CSV." },
  { id: "micros", name: "Oracle MICROS", kind: "api", description: "API/RES export connection. Until connected, use a CSV export with Generic CSV." },
  { id: "aloha", name: "NCR Aloha", kind: "api", description: "API/ETL connection. Until connected, use a CSV export with Generic CSV." },
  { id: "lightspeed", name: "Lightspeed", kind: "api", description: "API connection. Until connected, use a CSV export with Generic CSV." },
];

export const fileAdapters = POS_ADAPTERS.filter((a) => a.kind === "file");
export const getAdapter = (id: string) => POS_ADAPTERS.find((a) => a.id === id);
