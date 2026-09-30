import Link from "next/link";
import { redirect } from "next/navigation";
import { requireContext, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, ModalButton, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { LocationFields } from "./location-fields";
import { saveHierarchy, saveLocation } from "../actions";

export const metadata = { title: "Locations" };

export default async function LocationsPage() {
  const ctx = await requireContext();
  const manage = canOrg(ctx, "locations.manage");
  if (!manage && !can(ctx, "settings.manage")) redirect("/denied?perm=locations.manage");
  const supabase = await createClient();
  const [{ data: locs }, { data: regions }, { data: districts }] = await Promise.all([
    supabase.from("locations").select("id, code, name, city, state, market, active, region:regions(name), district:districts(name)").order("code"),
    supabase.from("regions").select("id, name, code").order("name"),
    supabase.from("districts").select("id, name, code, region_id").order("name"),
  ]);
  return (
    <>
      <PageHeader title="Locations & hierarchy" back={{ href: "/admin", label: "Administration" }}
        subtitle="Company → Region → District → Store"
        actions={manage ? (
          <ModalButton label="New location" title="New restaurant location" variant="primary" wide>
            <ActionForm action={saveLocation.bind(null, null)}>
              <LocationFields loc={null} regions={regions ?? []} districts={districts ?? []} hierarchyEditable />
              <p className="mt-3 text-xs text-muted">Every corporate product is added to the new location automatically. Add storage areas afterwards.</p>
              <div className="mt-3 flex justify-end"><SubmitButton>Create location</SubmitButton></div>
            </ActionForm>
          </ModalButton>
        ) : null} />
      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card padded={false}>
          <table className="tbl">
            <thead><tr><th>Store</th><th>City</th><th>Market</th><th>Region</th><th>District</th><th>Status</th></tr></thead>
            <tbody>
              {(locs ?? []).map((l) => (
                <tr key={l.id}>
                  <td><Link className="font-medium text-brand" href={`/admin/locations/${l.id}`}>#{l.code} {l.name}</Link></td>
                  <td>{[l.city, l.state].filter(Boolean).join(", ") || "—"}</td><td>{l.market ?? "—"}</td>
                  <td>{(l.region as unknown as { name: string } | null)?.name ?? "—"}</td><td>{(l.district as unknown as { name: string } | null)?.name ?? "—"}</td>
                  <td>{l.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
        {manage ? (
          <div className="space-y-4">
            <Card title="Regions">
              <ul className="mb-3 text-sm">{(regions ?? []).map((r) => <li key={r.id}>{r.name} {r.code ? <span className="text-muted">({r.code})</span> : null}</li>)}</ul>
              <ActionForm action={saveHierarchy.bind(null, "regions")} resetOnSuccess className="flex items-end gap-2">
                <Field label="New region" className="flex-1"><Input name="name" required /></Field><SubmitButton size="sm">Add</SubmitButton>
              </ActionForm>
            </Card>
            <Card title="Districts">
              <ul className="mb-3 text-sm">{(districts ?? []).map((r) => <li key={r.id}>{r.name}</li>)}</ul>
              <ActionForm action={saveHierarchy.bind(null, "districts")} resetOnSuccess className="space-y-2">
                <Field label="New district"><Input name="name" required /></Field>
                <Field label="Region"><Select name="region_id"><option value="">—</option>{(regions ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
                <SubmitButton size="sm">Add district</SubmitButton>
              </ActionForm>
            </Card>
          </div>
        ) : null}
      </div>
    </>
  );
}
