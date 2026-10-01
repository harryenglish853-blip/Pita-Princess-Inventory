import { Field, Input, Select } from "@/components/ui";

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "UTC"];
type L = Record<string, unknown> | null;
const s = (l: L, k: string) => (l?.[k] === null || l?.[k] === undefined ? "" : String(l[k]));

export function LocationFields({ loc, regions, districts, hierarchyEditable }: { loc: L; regions: { id: string; name: string }[]; districts: { id: string; name: string }[]; hierarchyEditable: boolean }) {
  return (
    <div className="space-y-4">
      <fieldset disabled={!hierarchyEditable} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Store #"><Input name="code" required defaultValue={s(loc, "code")} /></Field>
        <Field label="Name" className="lg:col-span-2"><Input name="name" required defaultValue={s(loc, "name")} /></Field>
        <Field label="Market"><Input name="market" defaultValue={s(loc, "market")} /></Field>
        <Field label="Type"><Select name="kind" defaultValue={s(loc, "kind") || "restaurant"}><option value="restaurant">Restaurant</option><option value="commissary">Commissary / central kitchen</option></Select></Field>
        <Field label="Region"><Select name="region_id" defaultValue={s(loc, "region_id")}><option value="">—</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        <Field label="District"><Select name="district_id" defaultValue={s(loc, "district_id")}><option value="">—</option>{districts.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
        <label className="inline-flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="active" defaultChecked={loc ? !!loc.active : true} /> Active</label>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Time zone"><Select name="timezone" defaultValue={s(loc, "timezone") || "America/New_York"}>{ZONES.map((z) => <option key={z}>{z}</option>)}</Select></Field>
        <Field label="Address"><Input name="address_line1" defaultValue={s(loc, "address_line1")} /></Field>
        <Field label="City"><Input name="city" defaultValue={s(loc, "city")} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="State"><Input name="state" defaultValue={s(loc, "state")} /></Field>
          <Field label="ZIP"><Input name="postal_code" defaultValue={s(loc, "postal_code")} /></Field>
        </div>
        <Field label="Phone"><Input name="phone" defaultValue={s(loc, "phone")} /></Field>
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Operating tolerances</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Count variance % (recount above)"><Input name="count_variance_pct_tolerance" inputMode="decimal" defaultValue={s(loc, "count_variance_pct_tolerance") || "10"} /></Field>
          <Field label="Count variance $ (recount above)"><Input name="count_variance_value_tolerance" inputMode="decimal" defaultValue={s(loc, "count_variance_value_tolerance") || "50"} /></Field>
          <Field label="Invoice over/short tolerance $"><Input name="invoice_tolerance" inputMode="decimal" defaultValue={s(loc, "invoice_tolerance") || "1.00"} /></Field>
          <Field label="Price increase alert %"><Input name="price_alert_pct" inputMode="decimal" defaultValue={s(loc, "price_alert_pct") || "5"} /></Field>
        </div>
      </div>
    </div>
  );
}
