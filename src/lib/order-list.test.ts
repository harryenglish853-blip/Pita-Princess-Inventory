import { describe, expect, it } from "vitest";
import { buildOrderList, formatOrderQty } from "./order-list";

describe("order list", () => {
  it("formats quantities without float noise", () => {
    expect(formatOrderQty("3.0000")).toBe("3");
    expect(formatOrderQty(0.1 + 0.2)).toBe("0.3");
    expect(formatOrderQty("1.50")).toBe("1.5");
  });

  it("builds the copy-paste list from the spec", () => {
    const text = buildOrderList({
      vendor: "Sysco", store: "#101 Demo Restaurant", deliveryLabel: "Fri, Oct 3",
      lines: [
        { name: "Chicken Breast", qty: 3, unit: "CASE", itemNumber: "48219" },
        { name: "French Fries", qty: "4", unit: "CASE" },
        { name: "Not needed", qty: "0", unit: "CASE" },
      ],
    });
    expect(text).toBe([
      "SYSCO ORDER",
      "#101 Demo Restaurant · Delivery Fri, Oct 3",
      "",
      "Chicken Breast — 3 CASE (#48219)",
      "French Fries — 4 CASE",
      "",
      "2 items",
    ].join("\n"));
  });

  it("says so when there is nothing to order", () => {
    expect(buildOrderList({ vendor: "Greco", lines: [] })).toContain("(nothing to order)");
  });
});
