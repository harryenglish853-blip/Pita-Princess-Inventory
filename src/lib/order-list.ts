import Decimal from "decimal.js";

export type OrderListLine = { name: string; qty: string | number; unit: string; itemNumber?: string | null };

/** Formats a quantity for an order list: no float artifacts, no trailing zeros ("1.50" → "1.5"). */
export function formatOrderQty(q: string | number): string {
  return new Decimal(String(q || 0)).toDecimalPlaces(4).toString();
}

/**
 * Plain-text order list for pasting into a vendor website, text or email:
 *
 *   SYSCO ORDER
 *   #101 Demo Restaurant · Delivery Fri, Oct 3
 *
 *   Chicken Breast — 3 CASE (#48219)
 *
 * Lines with a zero quantity are left out.
 */
export function buildOrderList(input: { vendor: string; store?: string; deliveryLabel?: string; account?: string | null; lines: OrderListLine[] }): string {
  const lines = input.lines.filter((l) => new Decimal(String(l.qty || 0)).gt(0));
  const header = [`${input.vendor.toUpperCase()} ORDER`];
  const meta = [input.store, input.deliveryLabel ? `Delivery ${input.deliveryLabel}` : null, input.account ? `Account ${input.account}` : null].filter(Boolean);
  if (meta.length) header.push(meta.join(" · "));
  const body = lines.map((l) => `${l.name} — ${formatOrderQty(l.qty)} ${l.unit}${l.itemNumber ? ` (#${l.itemNumber})` : ""}`);
  return [...header, "", ...(body.length ? body : ["(nothing to order)"]), "", `${lines.length} item${lines.length === 1 ? "" : "s"}`].join("\n");
}
