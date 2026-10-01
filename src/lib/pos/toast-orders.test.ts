import { describe, expect, it } from "vitest";
import { extractToastOrders, normalizeToastOrder } from "./toast-orders";

const order = {
  guid: "o-1", businessDate: 20261001, modifiedDate: "2026-10-01T18:15:00.000+0000", numberOfGuests: 3,
  checks: [
    { guid: "c-1", selections: [
      { guid: "s-1", item: { guid: "P200" }, displayName: "Cheeseburger", quantity: 2, price: 17.9 },
      { guid: "s-2", item: { guid: "P400" }, displayName: "French Fries", quantity: 2, price: 5.9, refundDetails: { refundAmount: 2.95 } },
      { guid: "s-3", item: { guid: "P100" }, displayName: "Grilled Chicken Pita", quantity: 1, price: 7.95, voided: true },
    ] },
    { guid: "c-2", voided: true, selections: [{ guid: "s-4", item: { guid: "P200" }, displayName: "Cheeseburger", quantity: 1, price: 8.95 }] },
  ],
};

describe("Toast order adapter", () => {
  it("normalizes dates, versions, quantities and money", () => {
    const n = normalizeToastOrder(order);
    expect(n.business_date).toBe("2026-10-01");
    expect(n.modified_at).toBe(Date.parse("2026-10-01T18:15:00.000Z"));
    expect(n.guest_count).toBe(3);
    expect(n.selections).toHaveLength(4);
    expect(n.selections[0]).toMatchObject({ item_guid: "P200", quantity: "2", refunded_quantity: "0", net_sales: "17.9", voided: false });
  });
  it("turns a half refund into a refunded quantity", () => {
    const fries = normalizeToastOrder(order).selections[1];
    expect(fries.refunded_quantity).toBe("1");
    expect(fries.net_sales).toBe("2.95");
  });
  it("marks voided selections and everything on a voided check", () => {
    const s = normalizeToastOrder(order).selections;
    expect(s[2].voided).toBe(true);
    expect(s[3].voided).toBe(true);
  });
  it("rejects orders it cannot date", () => {
    expect(() => normalizeToastOrder({ guid: "x", businessDate: "soon", modifiedDate: "2026-10-01T00:00:00Z" })).toThrow();
    expect(() => normalizeToastOrder({ guid: "x", businessDate: 20261001 })).toThrow();
  });
  it("finds orders in webhook envelopes and exports", () => {
    expect(extractToastOrders({ eventType: "orders_updated", details: { order } })).toHaveLength(1);
    expect(extractToastOrders([order, order])).toHaveLength(2);
    expect(extractToastOrders({ orders: [order] })).toHaveLength(1);
    expect(extractToastOrders({ hello: 1 })).toHaveLength(0);
  });
});
