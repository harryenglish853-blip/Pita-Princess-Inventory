import { describe, expect, it } from "vitest";
import { getAdapter } from "./adapters";
import { parseCsv } from "./csv-parse";

describe("csv parser", () => {
  it("handles quotes and commas", () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });
});

describe("POS adapters", () => {
  it("generic csv aggregates duplicate items", () => {
    const r = getAdapter("csv")!.parse!("item_id,item_name,quantity,net_sales\nP100,Chicken Sandwich,10,120.00\nP100,Chicken Sandwich,5,60\nP200,Burger,3,$33.00\n");
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0]).toMatchObject({ pos_item_id: "P100", quantity: 15, net_sales: 180 });
    expect(r.summary.net_sales).toBe(213);
  });
  it("toast item selection details (voids not depleted)", () => {
    const csv = 'Menu Item,Item Id,Qty,Net Price,Discount Amount,Void?\nBurger,P200,1,11.00,0,false\nBurger,P200,2,20.00,2.00,false\nBurger,P200,1,0,0,true\n';
    const r = getAdapter("toast")!.parse!(csv);
    expect(r.lines[0]).toMatchObject({ item_name: "Burger", quantity: 3, net_sales: 31, discounts: 2, voids: 1 });
    expect(r.warnings.join()).toMatch(/voided/);
  });
  it("square item sales", () => {
    const csv = "Item,Item Variation,SKU,Items Sold,Gross Sales,Discounts,Net Sales\nLatte,Large,LAT-L,12,$60.00,-$5.00,$55.00\nMuffin,Regular,MUF,4,$12.00,$0.00,$12.00\n";
    const r = getAdapter("square")!.parse!(csv);
    expect(r.lines.map((l) => [l.item_name, l.quantity, l.net_sales])).toEqual([["Latte (Large)", 12, 55], ["Muffin", 4, 12]]);
    expect(r.summary.discounts).toBe(5);
  });
  it("rejects the wrong format", () => {
    expect(() => getAdapter("toast")!.parse!("a,b\n1,2")).toThrow();
  });
});
