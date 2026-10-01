import Decimal from "decimal.js";

/**
 * Toast Orders API (v2) order JSON -> the neutral order shape stored by
 * `ingest_toast_order`. Kept separate from inventory logic: the database never
 * sees Toast-specific fields.
 *
 * NOT YET VERIFIED against a live Toast account (requires Toast partner API
 * access). Field names follow Toast's published order model: guid,
 * businessDate (yyyymmdd), modifiedDate, voided, deleted, numberOfGuests,
 * checks[].selections[] with item.guid, displayName, quantity, price, voided,
 * refundDetails.refundAmount.
 */
export type NeutralSelection = { guid: string; item_guid: string | null; name: string; quantity: string; refunded_quantity: string; net_sales: string; voided: boolean };
export type NeutralOrder = { guid: string; business_date: string; modified_at: number; voided: boolean; deleted: boolean; guest_count: number; selections: NeutralSelection[] };

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const dec = (v: unknown) => { try { const d = new Decimal(String(v ?? 0)); return d.isFinite() ? d : new Decimal(0); } catch { return new Decimal(0); } };

function businessDate(v: unknown): string {
  const s = String(v ?? "");
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  throw new Error(`Unrecognised businessDate "${s}"`);
}

function modifiedMs(o: J): number {
  const raw = o.modifiedDate ?? o.lastModifiedDate ?? o.closedDate ?? o.openedDate;
  const t = typeof raw === "number" ? raw : Date.parse(String(raw ?? "").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(t)) throw new Error("Order has no modifiedDate");
  return t;
}

/** Normalizes one Toast order. Throws on orders that cannot be dated or identified. */
export function normalizeToastOrder(o: J): NeutralOrder {
  if (!o || typeof o.guid !== "string") throw new Error("Order has no guid");
  const selections: NeutralSelection[] = [];
  for (const check of (o.checks ?? []) as J[]) {
    const checkVoid = !!(check.voided || check.deleted);
    for (const s of (check.selections ?? []) as J[]) {
      if (!s?.guid) continue;
      const qty = dec(s.quantity ?? 1);
      const price = dec(s.price ?? s.preDiscountPrice ?? 0);
      const refund = dec(s.refundDetails?.refundAmount ?? 0);
      // Toast reports refunds in dollars; refunded quantity is proportional to the refunded share of the price.
      const refundedQty = price.gt(0) ? Decimal.min(qty, qty.times(refund).div(price)).toDecimalPlaces(4) : new Decimal(0);
      selections.push({
        guid: String(s.guid), item_guid: s.item?.guid ? String(s.item.guid) : null,
        name: String(s.displayName ?? s.item?.name ?? "Unknown item"),
        quantity: qty.toString(), refunded_quantity: refundedQty.toString(),
        net_sales: Decimal.max(0, price.minus(refund)).toDecimalPlaces(2).toString(),
        voided: checkVoid || !!s.voided || !!s.deleted,
      });
    }
  }
  return {
    guid: o.guid, business_date: businessDate(o.businessDate), modified_at: modifiedMs(o),
    voided: !!o.voided, deleted: !!o.deleted, guest_count: Math.max(0, Number(o.numberOfGuests ?? 0) || 0), selections,
  };
}

/** Accepts a webhook envelope, a single order, or an array / {orders: []} export. */
export function extractToastOrders(body: unknown): J[] {
  if (Array.isArray(body)) return body as J[];
  const b = (body ?? {}) as J;
  if (Array.isArray(b.orders)) return b.orders as J[];
  if (b.details?.order) return [b.details.order as J];
  if (b.order) return [b.order as J];
  if (b.guid && (b.checks || b.businessDate)) return [b];
  return [];
}
