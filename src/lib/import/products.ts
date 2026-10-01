import { parseCsv } from "@/lib/pos/csv-parse";

/** Columns the product import understands, in template order. */
export const PRODUCT_COLUMNS = [
  { key: "name", label: "Item name", required: true, help: "What you call it, e.g. Chicken Breast" },
  { key: "item_number", label: "Item #", help: "Leave blank to number automatically" },
  { key: "category", label: "Category", help: "Protein, Produce, Dairy, Bakery, Paper…" },
  { key: "type", label: "Type", help: "Food, Beverage, Alcohol, Paper, Supplies or Other (blank = Food)" },
  { key: "count_unit", label: "Count unit", required: true, help: "The smallest unit you count in: LB, EA, OZ, GAL…" },
  { key: "case_unit", label: "Case unit", help: "How it arrives: CASE, BAG, BOX… (blank = CASE when Per case is filled)" },
  { key: "per_case", label: "Per case", help: "How many count units in one case, e.g. 40" },
  { key: "vendor", label: "Vendor", help: "Sysco, US Foods…" },
  { key: "vendor_item_number", label: "Vendor item #", help: "The vendor's code for it" },
  { key: "case_price", label: "Case price", help: "Price for one case (or one count unit if there is no case)" },
  { key: "storage_area", label: "Storage area", help: "Walk-In Cooler, Freezer, Dry Storage…" },
  { key: "shelf", label: "Shelf", help: "Optional, e.g. Shelf 2" },
  { key: "par", label: "Par", help: "How much you want on hand, in count units" },
  { key: "upc", label: "UPC", help: "Barcode, optional" },
] as const;
export type ProductImportKey = (typeof PRODUCT_COLUMNS)[number]["key"];
export type ProductImportRow = Partial<Record<ProductImportKey, string>>;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/** Header spellings seen on count sheets and vendor order-guide exports. */
const ALIASES: Record<ProductImportKey, string[]> = {
  name: ["item name", "item", "name", "product", "product name", "description", "item description", "product description"],
  item_number: ["item #", "item number", "item no", "product #", "product number", "our item #", "id"],
  category: ["category", "group", "class", "category name"],
  type: ["type", "cost group", "cost type"],
  count_unit: ["count unit", "count by", "unit", "uom", "inventory unit", "each unit", "unit of measure"],
  case_unit: ["case unit", "pack unit", "purchase unit", "order unit"],
  per_case: ["per case", "case size", "qty per case", "units per case", "pack", "pack qty", "case qty", "count per case"],
  vendor: ["vendor", "supplier", "distributor", "vendor name"],
  vendor_item_number: ["vendor item #", "vendor item number", "vendor item", "sku", "vendor sku", "supc", "item code", "vendor code", "mfr #"],
  case_price: ["case price", "price", "cost", "case cost", "unit price", "price per case"],
  storage_area: ["storage area", "storage", "location", "area", "storage location"],
  shelf: ["shelf", "bin", "position"],
  par: ["par", "par level", "par qty"],
  upc: ["upc", "barcode", "gtin"],
};

/** Maps each spreadsheet column to an import field (or null when unknown). */
export function mapHeaders(headers: string[]): (ProductImportKey | null)[] {
  const used = new Set<ProductImportKey>();
  return headers.map((h) => {
    const n = norm(h);
    for (const [key, names] of Object.entries(ALIASES) as [ProductImportKey, string[]][]) {
      if (!used.has(key) && names.some((a) => norm(a) === n)) { used.add(key); return key; }
    }
    return null;
  });
}

/** Parses pasted cells (tab-separated, as copied from Excel or Google Sheets) or CSV text. */
export function parseProductSheet(text: string): { rows: ProductImportRow[]; columns: { header: string; key: ProductImportKey | null }[] } {
  const firstLine = text.replace(/^﻿/, "").split(/\r?\n/)[0] ?? "";
  const grid = firstLine.includes("\t")
    ? text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.split("\t")).filter((r) => r.some((c) => c.trim() !== ""))
    : parseCsv(text);
  if (!grid.length) return { rows: [], columns: [] };
  const headers = grid[0].map((h) => h.trim());
  const keys = mapHeaders(headers);
  const rows = grid.slice(1).map((cells) => {
    const r: ProductImportRow = {};
    keys.forEach((k, i) => { if (k) r[k] = (cells[i] ?? "").trim(); });
    return r;
  }).filter((r) => Object.values(r).some((v) => v));
  return { rows, columns: headers.map((header, i) => ({ header, key: keys[i] })) };
}

/** Template with two example rows, for "Download template". */
export function productTemplateCsv(): string {
  const head = PRODUCT_COLUMNS.map((c) => c.label);
  const examples = [
    ["Chicken Breast, Boneless", "", "Protein", "Food", "LB", "CASE", "40", "Sysco", "1234567", "131.50", "Walk-In Cooler", "Shelf 2", "80", ""],
    ["Pita Bread", "", "Bakery", "Food", "EA", "BAG", "12", "Local Bakery", "", "6.00", "Dry Storage", "", "48", ""],
  ];
  return [head, ...examples].map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\r\n");
}
