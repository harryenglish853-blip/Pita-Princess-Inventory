import "server-only";
import type { PostgrestError } from "@supabase/supabase-js";
import type { ActionState } from "./action-types";

/** Turns a database error into a message a restaurant manager can act on. */
export function friendlyError(error: PostgrestError | Error | { message: string; code?: string } | null | undefined): string {
  if (!error) return "Something went wrong";
  const code = (error as PostgrestError).code;
  const msg = error.message ?? "Something went wrong";
  if (code === "42501" && /row-level security/i.test(msg)) return "You do not have permission to make this change.";
  if (code === "23505") {
    if (/products_organization_id_product_number/.test(msg)) return "That product number is already used.";
    if (/vendor_products_vendor_id_vendor_item_number/.test(msg)) return "That vendor item number is already on this vendor's order guide.";
    if (/receipts_invoice_uniq/.test(msg)) return "That invoice number was already entered for this vendor.";
    if (/_key|uniq/.test(msg) && !/already/i.test(msg)) return "That record already exists.";
  }
  if (code === "23503") return "This record is referenced by other data and cannot be changed that way.";
  if (code === "23514") return "A value is outside the allowed range.";
  if (code === "22P02") return "One of the values is not in the right format.";
  if (/fetch failed|ECONNREFUSED|NetworkError/i.test(msg)) return "Cannot reach the server. Check your connection and try again.";
  return msg;
}

export function fail(error: Parameters<typeof friendlyError>[0]): ActionState<never> {
  return { ok: false, error: friendlyError(error), at: Date.now() };
}

export function ok<T>(message?: string, data?: T): ActionState<T> {
  return { ok: true, message, data, at: Date.now() };
}

// FormData helpers
export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v.trim() : "";
};
export const optStr = (fd: FormData, k: string) => str(fd, k) || null;
export const optNum = (fd: FormData, k: string) => {
  const v = str(fd, k);
  if (v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
  return v; // keep as string: numeric precision is preserved by Postgres
};
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";
