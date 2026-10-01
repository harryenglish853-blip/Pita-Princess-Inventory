import { describe, expect, it } from "vitest";
import { change, esc, fmtMoney, fmtPct, fmtPts, renderEmail } from "./templates";

const loc = { location: { id: "l1", code: "101", name: "Demo Restaurant", timezone: "America/New_York" }, organization: "Pita Princess" };

describe("email formatting", () => {
  it("escapes HTML", () => {
    expect(esc(`<script>alert("x")</script>&'`)).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });
  it("formats money exactly (no float drift)", () => {
    expect(fmtMoney("17482")).toBe("$17,482.00");
    expect(fmtMoney(0.1 + 0.2)).toBe("$0.30");
    expect(fmtMoney("-19.2")).toBe("-$19.20");
    expect(fmtMoney(null)).toBe("—");
  });
  it("formats percentages and points", () => {
    expect(fmtPct("28.94")).toBe("28.9%");
    expect(fmtPts("1.8")).toBe("+1.8 pts");
    expect(fmtPts("-0.25")).toBe("-0.3 pts");
  });
  it("computes month-over-month change with decimals", () => {
    expect(change("93284", "88000")).toBe("+$5,284.00 (+6.0%)");
    expect(change("100", "0")).toBe("+$100.00");
  });
});

describe("templates", () => {
  it("daily report shows the stored figures and escapes alert text", () => {
    const r = renderEmail({ id: "1", kind: "daily_report", subject: "Daily Restaurant Operations — October 1", payload: {
      ...loc, template: "daily", date: "2026-09-30", sales: 17482, waste: "92.40", deliveries: 3, delivery_issues: 1, low_stock: 7, critical_stock: 2,
      theoretical_pct: "28.9", attention: [{ title: "Low stock: Chicken <Breast>", message: "18 LB", severity: "warning" }],
      delivery_issue_list: [{ vendor: "Sysco", invoice_number: "33842", issues: "short" }],
    } }, "https://inventory.example.com/");
    expect(r.html).toContain("$17,482.00");
    expect(r.html).toContain("$92.40");
    expect(r.html).toContain("28.9%");
    expect(r.html).toContain("Chicken &lt;Breast&gt;");
    expect(r.html).not.toContain("<Breast>");
    expect(r.html).toContain('href="https://inventory.example.com/"');
    expect(r.text).toContain("Sales: $17,482.00");
    expect(r.text).toContain("Critical: 2");
  });

  it("weekly report reconciles and lists vendor spending", () => {
    const r = renderEmail({ id: "2", kind: "weekly_report", subject: "Weekly", payload: {
      ...loc, template: "weekly", from: "2026-09-21", to: "2026-09-27", sales: "93284", purchases: "27381", waste: "612",
      food_cost: { begin_inventory: "35000", end_inventory: "34920", purchases: "27381", transfers: "0", actual_cost: "27461", actual_pct: "29.44",
                   theoretical_cost: "26026", theoretical_pct: "27.9", variance: "1435", variance_pct_points: "1.54", basis: "count_to_count",
                   begin_count: "Weekly Count Sep 20", end_count: "Weekly Count Sep 27" },
      vendor_spending: [{ vendor: "Sysco", total: "18420", deliveries: 2 }, { vendor: "Greco", total: "6482", deliveries: 2 }],
      top_variances: [{ name: "Chicken", value: "-182", qty: "-57", unit: "LB" }], top_waste: [], price_alerts: [], delivery_discrepancies: [], low_stock: [], counts: [],
    } }, "https://x.test");
    expect(r.html).toContain("Sep 21 – Sep 27");
    expect(r.html).toContain("$18,420.00");
    expect(r.html).toContain("29.4%");
    expect(r.html).toContain("+1.5 pts");
    expect(r.html).toContain("count to count");
    expect(r.html).toContain("-$182.00");
    expect(r.html).toContain('href="https://x.test/food-cost"');
  });

  it("commissary order lists items and links to the order", () => {
    const r = renderEmail({ id: "3", kind: "commissary_order", subject: "Commissary Order CO-000001", payload: {
      ...loc, template: "commissary_order", order_number: "CO-000001", restaurant: "101 Demo Restaurant", needed_date: "2026-10-02",
      lines: [{ name: "Pizza Dough", qty: "120", unit: "EA" }, { name: "House Sauce", qty: "4", unit: "CTN" }], link: "/commissary/abc",
    } }, "https://x.test");
    expect(r.html).toContain("Pizza Dough");
    expect(r.html).toContain("120 EA");
    expect(r.html).toContain("Friday, Oct 2");
    expect(r.html).toContain('href="https://x.test/commissary/abc"');
    expect(r.text).toContain("Pizza Dough — 120 EA");
  });

  it("alert links never leave the app", () => {
    const r = renderEmail({ id: "4", kind: "price_alert", subject: "Price increase", payload: { ...loc, template: "alert", title: "Price increase: Mozzarella",
      message: "2.92 → 3.20 per LB (+9.59%)", link: "https://evil.example/phish" } }, "https://x.test");
    expect(r.html).not.toContain("evil.example");
    expect(r.html).toContain('href="https://x.test/tasks"');
  });
});
