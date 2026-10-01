import { describe, expect, it } from "vitest";
import { mapHeaders, parseProductSheet, productTemplateCsv } from "./products";

describe("product import parsing", () => {
  it("understands common header spellings", () => {
    expect(mapHeaders(["Product Description", "Pack", "UOM", "Supplier", "SUPC", "Price", "Storage"]))
      .toEqual(["name", "per_case", "count_unit", "vendor", "vendor_item_number", "case_price", "storage_area"]);
  });
  it("ignores unknown columns and never maps two columns to one field", () => {
    expect(mapHeaders(["Item", "Notes", "Description"])).toEqual(["name", null, null]);
  });
  it("reads cells pasted from a spreadsheet (tab separated)", () => {
    const { rows, columns } = parseProductSheet("Item name\tCount unit\tPer case\nChicken\tLB\t40\n\t\t\nRice\tLB\t50\n");
    expect(columns.map((c) => c.key)).toEqual(["name", "count_unit", "per_case"]);
    expect(rows).toEqual([{ name: "Chicken", count_unit: "LB", per_case: "40" }, { name: "Rice", count_unit: "LB", per_case: "50" }]);
  });
  it("reads CSV with quoted commas", () => {
    const { rows } = parseProductSheet('Item name,Count unit\n"Chicken Breast, Boneless",LB\n');
    expect(rows[0].name).toBe("Chicken Breast, Boneless");
  });
  it("the template parses back to its own example rows", () => {
    const { rows, columns } = parseProductSheet(productTemplateCsv());
    expect(columns.every((c) => c.key)).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "Chicken Breast, Boneless", count_unit: "LB", per_case: "40", case_price: "131.50" });
  });
});
