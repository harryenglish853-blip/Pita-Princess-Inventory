import { describe, expect, it } from "vitest";
import { parseVoiceCount, tokenize, type VoiceLine } from "./parse";

const lb = { unit_id: "lb", code: "LB" }, cs = { unit_id: "cs", code: "CASE" }, ea = { unit_id: "ea", code: "EA" }, bag = { unit_id: "bag", code: "BAG" }, qt = { unit_id: "qt", code: "QT" }, ctn = { unit_id: "ctn", code: "CTN" };
const lines: VoiceLine[] = [
  { key: "chicken", name: "Chicken Breast, Boneless", units: [cs, lb], inventory_unit_id: "lb" },
  { key: "avocado", name: "Avocado, Hass", units: [cs, ea], inventory_unit_id: "ea" },
  { key: "fries", name: 'French Fries 3/8"', units: [cs, bag, lb], inventory_unit_id: "lb" },
  { key: "cream", name: "Heavy Cream", units: [cs, ctn, qt], inventory_unit_id: "qt" },
  { key: "beef", name: "Ground Beef 80/20", units: [cs, lb], inventory_unit_id: "lb" },
  { key: "cheddar", name: "Cheddar, Sliced", units: [cs, lb], inventory_unit_id: "lb" },
];

describe("tokenize numbers", () => {
  it("handles fractions and compounds", () => {
    const nums = (s: string) => tokenize(s).filter((t) => t.kind === "num").map((t) => (t as { value: number }).value);
    expect(nums("eight and a half pounds")).toEqual([8.5]);
    expect(nums("twenty two")).toEqual([22]);
    expect(nums("one hundred five")).toEqual([105]);
    expect(nums("2.5 cases")).toEqual([2.5]);
    expect(nums("three point five")).toEqual([3.5]);
    expect(nums("a half case")).toEqual([0.5]);
  });
});

describe("parseVoiceCount", () => {
  it("case + weight (spec example)", () => {
    const r = parseVoiceCount("Chicken breast, one case and eight and a half pounds.", lines, null);
    expect(r.line?.key).toBe("chicken");
    expect(r.breakdown).toEqual([{ unit_id: "cs", code: "CASE", qty: 1 }, { unit_id: "lb", code: "LB", qty: 8.5 }]);
    expect(r.confidence).toBeGreaterThan(0.8);
  });
  it("single unit", () => {
    const r = parseVoiceCount("Chicken breast 12 pounds", lines, null);
    expect(r.breakdown).toEqual([{ unit_id: "lb", code: "LB", qty: 12 }]);
  });
  it("case + each", () => {
    const r = parseVoiceCount("Avocado two cases six each", lines, null);
    expect(r.line?.key).toBe("avocado");
    expect(r.breakdown).toEqual([{ unit_id: "cs", code: "CASE", qty: 2 }, { unit_id: "ea", code: "EA", qty: 6 }]);
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });
  it("case + bags", () => {
    const r = parseVoiceCount("Fries three cases four bags", lines, null);
    expect(r.line?.key).toBe("fries");
    expect(r.breakdown).toEqual([{ unit_id: "cs", code: "CASE", qty: 3 }, { unit_id: "bag", code: "BAG", qty: 4 }]);
  });
  it("cartons", () => {
    const r = parseVoiceCount("Heavy cream eight cartons", lines, null);
    expect(r.line?.key).toBe("cream");
    expect(r.breakdown).toEqual([{ unit_id: "ctn", code: "CTN", qty: 8 }]);
  });
  it("quantity only uses the current item", () => {
    const r = parseVoiceCount("fourteen pounds", lines, lines[4]);
    expect(r.line?.key).toBe("beef");
    expect(r.breakdown).toEqual([{ unit_id: "lb", code: "LB", qty: 14 }]);
  });
  it("bare trailing number goes to the inventory unit", () => {
    const r = parseVoiceCount("chicken two cases six", lines, null);
    expect(r.breakdown).toEqual([{ unit_id: "cs", code: "CASE", qty: 2 }, { unit_id: "lb", code: "LB", qty: 6 }]);
  });
  it("unknown product is low confidence", () => {
    const r = parseVoiceCount("salmon five pounds", lines, null);
    expect(r.line).toBeNull();
    expect(r.confidence).toBe(0);
    expect(r.issues.length).toBeGreaterThan(0);
  });
  it("unit the product does not use is flagged", () => {
    const r = parseVoiceCount("cheddar three bags", lines, null);
    expect(r.issues.join()).toMatch(/not counted in BAG/);
    expect(r.confidence).toBeLessThan(0.8);
  });
  it("tolerates small misrecognitions", () => {
    const r = parseVoiceCount("chiken brest 10 lbs", lines, null);
    expect(r.line?.key).toBe("chicken");
    expect(r.breakdown[0].qty).toBe(10);
  });
});
