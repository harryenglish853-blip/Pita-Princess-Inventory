import { Field, Input, Select, Textarea } from "@/components/ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type V = Record<string, unknown> | null;
const s = (v: V, k: string) => (v?.[k] === null || v?.[k] === undefined ? "" : String(v[k]));

export function VendorFields({ vendor, disabled, locations = [] }: { vendor: V; disabled?: boolean; locations?: { id: string; code: string; name: string }[] }) {
  const days = (vendor?.delivery_days as number[] | undefined) ?? [];
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Vendor name *" className="sm:col-span-2"><Input name="name" required defaultValue={s(vendor, "name")} /></Field>
      <Field label="Kind" hint="Commissary = your own central kitchen, ordered and received inside this app">
        <Select name="kind" defaultValue={s(vendor, "kind") || "distributor"}>
          <option value="distributor">Distributor (Sysco, Greco…)</option><option value="commissary">Commissary / central kitchen</option><option value="other">Other</option>
        </Select>
      </Field>
      <Field label="Commissary location" hint="Only for kind Commissary">
        <Select name="supplying_location_id" defaultValue={s(vendor, "supplying_location_id")}>
          <option value="">—</option>{locations.map((l) => <option key={l.id} value={l.id}>#{l.code} {l.name}</option>)}
        </Select>
      </Field>
      <Field label="Vendor #"><Input name="vendor_number" defaultValue={s(vendor, "vendor_number")} /></Field>
      <Field label="Our account #"><Input name="account_number" defaultValue={s(vendor, "account_number")} /></Field>
      <Field label="Sales rep"><Input name="sales_rep" defaultValue={s(vendor, "sales_rep")} /></Field>
      <Field label="Phone"><Input name="phone" type="tel" defaultValue={s(vendor, "phone")} /></Field>
      <Field label="Email"><Input name="email" type="email" defaultValue={s(vendor, "email")} /></Field>
      <Field label="Ordering email"><Input name="ordering_email" type="email" defaultValue={s(vendor, "ordering_email")} /></Field>
      <Field label="Ordering website" className="sm:col-span-2" hint="Opened by the Open website button in the Ordering center. Passwords are never stored here."><Input name="order_website" type="url" pattern="https?://.+" placeholder="https://shop.sysco.com" defaultValue={s(vendor, "order_website")} /></Field>
      <Field label="Lead time (days)"><Input name="lead_time_days" inputMode="numeric" defaultValue={s(vendor, "lead_time_days") || "1"} /></Field>
      <Field label="Order cutoff"><Input name="order_cutoff" type="time" defaultValue={s(vendor, "order_cutoff").slice(0, 5)} /></Field>
      <div className="sm:col-span-2">
        <span className="mb-1 block text-xs font-medium text-muted">Delivery days</span>
        <div className="flex flex-wrap gap-2">
          {DAYS.map((d, i) => (
            <label key={d} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-sm">
              <input type="checkbox" name="delivery_days" value={i} defaultChecked={days.includes(i)} /> {d}
            </label>
          ))}
        </div>
      </div>
      <Field label="Minimum order $"><Input name="minimum_order" inputMode="decimal" defaultValue={s(vendor, "minimum_order")} /></Field>
      <Field label="Payment terms"><Input name="payment_terms" defaultValue={s(vendor, "payment_terms")} /></Field>
      <Field label="Freight rules" className="sm:col-span-2"><Input name="freight_rules" defaultValue={s(vendor, "freight_rules")} /></Field>
      <div className="flex flex-wrap items-center gap-4 text-sm sm:col-span-2">
        <label className="inline-flex items-center gap-2"><input type="checkbox" name="edi_enabled" defaultChecked={!!vendor?.edi_enabled} /> EDI enabled</label>
        <label className="inline-flex items-center gap-2"><input type="checkbox" name="einvoice_enabled" defaultChecked={!!vendor?.einvoice_enabled} /> Electronic invoices</label>
        <label className="inline-flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={vendor ? !!vendor.active : true} /> Active</label>
      </div>
      <Field label="Notes" className="sm:col-span-2 lg:col-span-4"><Textarea name="notes" defaultValue={s(vendor, "notes")} /></Field>
    </fieldset>
  );
}

export const dayNames = (days: number[] | null | undefined) => (days ?? []).map((d) => DAYS[d]).join(", ") || "—";
