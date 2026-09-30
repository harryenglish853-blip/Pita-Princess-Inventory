import Decimal from "decimal.js";

type Num = number | string | null | undefined | Decimal;

const toNum = (v: Num): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = v instanceof Decimal ? v.toNumber() : Number(v);
  return Number.isFinite(n) ? n : null;
};

const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const moneyFmt4 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function money(v: Num, opts?: { precise?: boolean; sign?: boolean }): string {
  const n = toNum(v);
  if (n === null) return "—";
  const s = (opts?.precise ? moneyFmt4 : moneyFmt).format(n);
  return opts?.sign && n > 0 ? `+${s}` : s;
}

export function qty(v: Num, unit?: string | null, digits = 2): string {
  const n = toNum(v);
  if (n === null) return "—";
  const s = n.toLocaleString("en-US", { maximumFractionDigits: digits });
  return unit ? `${s} ${unit}` : s;
}

export function signedQty(v: Num, unit?: string | null): string {
  const n = toNum(v);
  if (n === null) return "—";
  return (n > 0 ? "+" : "") + qty(n, unit);
}

export function pct(v: Num, digits = 1, sign = false): string {
  const n = toNum(v);
  if (n === null) return "—";
  return `${sign && n > 0 ? "+" : ""}${n.toFixed(digits)}%`;
}

export function dateFmt(v: string | Date | null | undefined, tz?: string): string {
  if (!v) return "—";
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00`) : new Date(v);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: typeof v === "string" && v.length === 10 ? undefined : tz });
}

export function dateTimeFmt(v: string | Date | null | undefined, tz?: string): string {
  if (!v) return "—";
  return new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: tz });
}

export function titleCase(s: string | null | undefined): string {
  if (!s) return "";
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Today's date (YYYY-MM-DD) in a timezone. */
export function todayIn(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
