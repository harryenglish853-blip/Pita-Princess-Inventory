import { describe, expect, it } from "vitest";
import { evaluate } from "./calc";
import { breakdownToBase, splitIntoUnits } from "./units";

describe("calculator", () => {
  it("evaluates safe arithmetic", () => {
    expect(evaluate("3*12+4")).toBe(40);
    expect(evaluate("2.5 + 1/2")).toBe(3);
    expect(evaluate("(1+2)*3")).toBe(9);
    expect(evaluate("0.1+0.2")).toBe(0.3);
    expect(evaluate("4x6")).toBe(24);
  });
  it("rejects garbage", () => {
    expect(evaluate("alert(1)")).toBeNull();
    expect(evaluate("1/0")).toBeNull();
    expect(evaluate("2+")).toBeNull();
    expect(evaluate("")).toBeNull();
  });
});

describe("unit engine (client view)", () => {
  const units = [{ unit_id: "cs", code: "CASE", factor: "40" }, { unit_id: "lb", code: "LB", factor: 1 }, { unit_id: "oz", code: "OZ", factor: "0.0625" }];
  it("case + weight", () => {
    expect(breakdownToBase(units, [{ unit_id: "cs", qty: "1" }, { unit_id: "lb", qty: "8.5" }]).toNumber()).toBe(48.5);
  });
  it("uses exact decimals", () => {
    expect(breakdownToBase(units, [{ unit_id: "oz", qty: "800" }]).toNumber()).toBe(50);
    expect(breakdownToBase([{ unit_id: "a", code: "A", factor: "0.1" }], [{ unit_id: "a", qty: "3" }]).toString()).toBe("0.3");
  });
  it("splits into packages", () => {
    const s = splitIntoUnits(units, 48.5, "lb");
    expect(s.map((x) => [x.unit.code, x.qty.toNumber()])).toEqual([["CASE", 1], ["LB", 8.5]]);
  });
  it("throws on unknown unit", () => {
    expect(() => breakdownToBase(units, [{ unit_id: "bag", qty: "1" }])).toThrow();
  });
});
