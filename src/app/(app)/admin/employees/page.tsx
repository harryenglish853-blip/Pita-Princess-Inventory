import { redirect } from "next/navigation";
import { requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, ModalButton, SubmitButton } from "@/components/client";
import { Badge, Card, EmptyState, Field, Input, PageHeader, Select } from "@/components/ui";
import { dateTimeFmt } from "@/lib/format";
import { saveEmployee, unlockEmployee } from "../actions";

export const metadata = { title: "Employees & PINs" };

type Emp = { id: string; display_name: string; location_id: string | null; location_name: string | null; active: boolean; locked: boolean; last_seen: string | null; actions_30d: number };

function EmployeeForm({ e, locations, defaultLocation }: { e?: Emp; locations: { id: string; code: string; name: string }[]; defaultLocation: string }) {
  return (
    <ActionForm action={saveEmployee.bind(null, e?.id ?? null)} className="space-y-3">
      <Field label="Name shown on the “Who are you?” screen"><Input name="display_name" defaultValue={e?.display_name} required maxLength={40} autoComplete="off" /></Field>
      <Field label="Store">
        <Select name="location_id" defaultValue={e ? e.location_id ?? "" : defaultLocation}>
          <option value="">All stores</option>
          {locations.map((l) => <option key={l.id} value={l.id}>#{l.code} {l.name}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={e ? "New PIN (leave blank to keep)" : "4-digit PIN"}>
          <Input name="pin" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" required={!e} />
        </Field>
        <Field label="Repeat PIN"><Input name="pin_confirm" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} autoComplete="off" required={!e} /></Field>
      </div>
      <p className="text-xs text-muted">Tell the person their PIN in private. Repeated or sequential PINs (1111, 1234) are not allowed. Five wrong tries lock the name for 5 minutes.</p>
      {e ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={e.active} /> Active</label> : null}
      <div className="flex justify-end"><SubmitButton>{e ? "Save" : "Add employee"}</SubmitButton></div>
    </ActionForm>
  );
}

export default async function EmployeesPage() {
  const ctx = await requireContext();
  if (!ctx.locations.some((l) => l.permissions.includes("users.manage"))) redirect("/denied?perm=users.manage");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_employees", { p_org: ctx.organizationId });
  const people = (data ?? []) as Emp[];
  const locations = ctx.locations.filter((l) => l.permissions.includes("users.manage"));
  return (
    <>
      <PageHeader title="Employees & PINs" back={{ href: "/admin", label: "Administration" }}
        subtitle="People who use a shared login pick their name and enter a personal PIN. Every action is recorded under their name."
        actions={<ModalButton label="Add employee" title="Add employee" variant="primary"><EmployeeForm locations={locations} defaultLocation={ctx.location.id} /></ModalButton>} />
      {error ? <p className="text-danger">{error.message}</p> : null}
      {!people.length ? (
        <EmptyState title="No employees yet">Add the people who share the employee login. Then mark that login as shared under Users &amp; permissions.</EmptyState>
      ) : (
        <Card padded={false}>
          <table className="tbl">
            <thead><tr><th>Name</th><th>Store</th><th>Status</th><th>Last signed in</th><th className="text-right">Actions (30 days)</th><th /></tr></thead>
            <tbody>
              {people.map((e) => (
                <tr key={e.id} className={!e.active ? "opacity-60" : ""}>
                  <td className="font-medium">{e.display_name}</td>
                  <td>{e.location_name ?? "All stores"}</td>
                  <td className="space-x-1">{e.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}{e.locked ? <Badge tone="danger">Locked</Badge> : null}</td>
                  <td className="whitespace-nowrap">{e.last_seen ? dateTimeFmt(e.last_seen) : "Never"}</td>
                  <td className="text-right tabular-nums">{e.actions_30d}</td>
                  <td className="whitespace-nowrap text-right">
                    {e.locked ? <ActionButton size="sm" variant="ghost" action={unlockEmployee.bind(null, e.id)}>Unlock</ActionButton> : null}
                    <ModalButton label="Edit" title={`Edit ${e.display_name}`} size="sm" variant="ghost"><EmployeeForm e={e} locations={locations} defaultLocation={ctx.location.id} /></ModalButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
