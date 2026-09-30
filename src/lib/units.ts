import Decimal from "decimal.js";

/**
 * Client-side view of the central unit conversion engine. Factors always come from the
 * database view `product_unit_options` (inventory units per 1 unit); this module never
 * invents a conversion. The server recomputes every total from the same factors.
 */
export type UnitOption = { unit_id: string; code: string; name?: string; factor: number | string };
export type BreakdownLine = { unit_id: string; qty: string | number | null };

export function factorOf(units: UnitOption[], unitId: string): Decimal | null {
  const u = units.find((x) => x.unit_id === unitId);
  return u ? new Decimal(u.factor) : null;
}

/** Sum of a multi-unit entry (e.g. 1 CASE + 8.5 LB) in inventory units. */
export function breakdownToBase(units: UnitOption[], lines: BreakdownLine[]): Decimal {
  let total = new Decimal(0);
  for (const l of lines) {
    if (l.qty === null || l.qty === "" || l.qty === undefined) continue;
    const f = factorOf(units, l.unit_id);
    if (!f) throw new Error(`No conversion for unit ${l.unit_id}`);
    total = total.plus(new Decimal(l.qty).times(f));
  }
  return total.toDecimalPlaces(4);
}

export function convert(units: UnitOption[], value: Decimal.Value, fromUnit: string, toUnit: string): Decimal {
  const f = factorOf(units, fromUnit);
  const t = factorOf(units, toUnit);
  if (!f || !t) throw new Error("No conversion between these units");
  return new Decimal(value).times(f).dividedBy(t);
}

/** Express a base quantity in the largest whole package + remainder (e.g. 48.5 LB -> 1 CASE + 8.5 LB). */
export function splitIntoUnits(units: UnitOption[], base: Decimal.Value, baseUnitId: string): { unit: UnitOption; qty: Decimal }[] {
  const b = units.find((u) => u.unit_id === baseUnitId);
  if (!b) return [];
  let remaining = new Decimal(base);
  const out: { unit: UnitOption; qty: Decimal }[] = [];
  const bigger = units.filter((u) => new Decimal(u.factor).gt(1)).sort((a, z) => Number(z.factor) - Number(a.factor));
  for (const u of bigger) {
    const n = remaining.dividedBy(u.factor).floor();
    if (n.gt(0)) {
      out.push({ unit: u, qty: n });
      remaining = remaining.minus(n.times(u.factor));
    }
  }
  if (remaining.gt(0) || out.length === 0) out.push({ unit: b, qty: remaining.toDecimalPlaces(4) });
  return out;
}
