import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, Textarea } from "@/components/ui";
import { resetStoreVendor, saveStoreVendor } from "./actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const dayList = (d: number[] | null | undefined) => (d?.length ? [...d].sort().map((i) => DAYS[i]).join(", ") : "none");

type Company = { delivery_days: number[]; lead_time_days: number; order_cutoff: string | null; account_number: string | null };
type Override = { delivery_days: number[] | null; lead_time_days: number | null; order_cutoff: string | null; account_number: string | null; active: boolean; notes: string | null } | null;

/** This store's schedule for a vendor, with store-level overrides of the company settings. */
export function StoreVendorSettings({ vendorId, storeLabel, company, override, editable }: {
  vendorId: string; storeLabel: string; company: Company; override: Override; editable: boolean;
}) {
  const eff = {
    days: override?.delivery_days ?? company.delivery_days,
    lead: override?.lead_time_days ?? company.lead_time_days,
    cutoff: override?.order_cutoff ?? company.order_cutoff,
    account: override?.account_number ?? company.account_number,
  };
  const inactive = override && !override.active;
  return (
    <Card title={<span className="flex items-center gap-2">This store {override ? <Badge tone="brand">Custom</Badge> : null}{inactive ? <Badge tone="danger">Not used</Badge> : null}</span>}>
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-testid="store-vendor-effective">
        <dt className="text-muted">Store</dt><dd>{storeLabel}</dd>
        <dt className="text-muted">Delivers</dt><dd>{dayList(eff.days)}{override?.delivery_days ? " *" : ""}</dd>
        <dt className="text-muted">Lead time</dt><dd>{eff.lead} day(s){override?.lead_time_days != null ? " *" : ""}</dd>
        <dt className="text-muted">Cutoff</dt><dd>{eff.cutoff?.slice(0, 5) ?? "—"}{override?.order_cutoff ? " *" : ""}</dd>
        <dt className="text-muted">Account #</dt><dd>{eff.account ?? "—"}{override?.account_number ? " *" : ""}</dd>
      </dl>
      {override ? <p className="mb-3 text-xs text-muted">* set for this store; everything else follows the company settings.</p> : null}
      {editable ? (
        <details data-testid="store-vendor-settings">
          <summary className="cursor-pointer text-sm font-medium text-brand">Change for this store</summary>
          <ActionForm action={saveStoreVendor.bind(null, vendorId)} className="mt-3 space-y-3">
            <p className="text-xs text-muted">Leave a field blank to use the company value.</p>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="override_days" defaultChecked={!!override?.delivery_days} /> Different delivery days here
            </label>
            <div className="flex flex-wrap gap-1.5">
              {DAYS.map((d, i) => (
                <label key={d} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-sm">
                  <input type="checkbox" name="delivery_days" value={i} defaultChecked={(override?.delivery_days ?? company.delivery_days).includes(i)} /> {d}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Lead time (days)"><Input name="lead_time_days" inputMode="numeric" placeholder={String(company.lead_time_days)} defaultValue={override?.lead_time_days ?? ""} /></Field>
              <Field label="Order cutoff"><Input name="order_cutoff" type="time" defaultValue={override?.order_cutoff?.slice(0, 5) ?? ""} /></Field>
            </div>
            <Field label="Store account #"><Input name="account_number" placeholder={company.account_number ?? ""} defaultValue={override?.account_number ?? ""} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={override ? override.active : true} /> This store orders from this vendor</label>
            <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={override?.notes ?? ""} /></Field>
            <div className="flex flex-wrap justify-end gap-2">
              {override ? <ActionButton action={resetStoreVendor.bind(null, vendorId)} size="sm" variant="ghost" confirm="Remove this store's changes and use the company settings?">Use company settings</ActionButton> : null}
              <SubmitButton size="sm">Save for this store</SubmitButton>
            </div>
          </ActionForm>
        </details>
      ) : null}
    </Card>
  );
}
