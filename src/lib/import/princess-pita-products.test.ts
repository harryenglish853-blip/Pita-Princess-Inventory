import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseProductSheet } from "./products";

// Built-in unit codes (supabase/migrations/..._catalog.sql). The import also accepts plural spellings.
const UNITS = new Set(["BAG", "BATCH", "BOX", "BTL", "BUNCH", "CAN", "CASE", "CTN", "CUP", "DZ", "EA", "FL OZ", "G", "GAL", "JUG", "KEG", "KG", "L",
  "LB", "ML", "OZ", "PAN", "PK", "PORTION", "PT", "QT", "ROLL", "SLEEVE", "TBSP", "TSP", "TUB"]);

describe("Princess Pita product list (from the Sysco, Greco and Commissary order sheets)", () => {
  const file = readFileSync(path.resolve(__dirname, "../../../supabase/production/princess-pita-products.csv"), "utf8");
  const { rows, columns } = parseProductSheet(file);

  it("maps every import column and ignores the confirmation notes", () => {
    expect(columns.filter((c) => c.key).map((c) => c.key)).toContain("count_unit");
    expect(columns.find((c) => c.header === "Please confirm")?.key).toBeNull();
  });
  it("has every item from the three sheets, once", () => {
    expect(rows).toHaveLength(58);
    expect(new Set(rows.map((r) => r.name!.toLowerCase())).size).toBe(rows.length);
    const by = (v: string) => rows.filter((r) => r.vendor === v).length;
    expect([by("Sysco"), by("Greco"), by("Commissary")]).toEqual([17, 23, 18]);
  });
  it("uses only known count units and invents no prices, case sizes or pars", () => {
    for (const r of rows) {
      expect(UNITS.has(r.count_unit!), `${r.name}: ${r.count_unit}`).toBe(true);
      expect(r.case_price ?? "", r.name).toBe("");
      expect(r.per_case ?? "", r.name).toBe("");
      expect(r.par ?? "", r.name).toBe("");
    }
  });
});
