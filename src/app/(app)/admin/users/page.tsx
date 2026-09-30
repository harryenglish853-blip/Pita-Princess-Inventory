import { redirect } from "next/navigation";
import { requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, ModalButton, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { ROLE_OPTIONS } from "@/lib/permissions";
import { grantRole, inviteUser, revokeRole, setMemberActive } from "../actions";

export const metadata = { title: "Users & permissions" };

type Role = { id: string; role: string; name: string; scope_type: string; scope_name: string };

export default async function UsersPage() {
  const ctx = await requireContext();
  if (!ctx.locations.some((l) => l.permissions.includes("users.manage"))) redirect("/denied?perm=users.manage");
  const supabase = await createClient();
  const [{ data: users, error }, { data: regions }, { data: districts }, { data: perms }, { data: rolePerms }] = await Promise.all([
    supabase.rpc("list_org_users", { p_org: ctx.organizationId }),
    supabase.from("regions").select("id, name").order("name"),
    supabase.from("districts").select("id, name").order("name"),
    supabase.from("permissions").select("key, module, description").order("module"),
    supabase.from("role_permissions").select("permission_key, role:roles!inner(key, organization_id)").is("role.organization_id", null),
  ]);
  if (error) throw new Error(error.message);
  const scopeOptions = (
    <>
      <option value={`organization:${ctx.organizationId}`}>All locations (company)</option>
      {(regions ?? []).map((r) => <option key={r.id} value={`region:${r.id}`}>Region: {r.name}</option>)}
      {(districts ?? []).map((d) => <option key={d.id} value={`district:${d.id}`}>District: {d.name}</option>)}
      {ctx.locations.filter((l) => l.permissions.includes("users.manage")).map((l) => <option key={l.id} value={`location:${l.id}`}>Store #{l.code} {l.name}</option>)}
    </>
  );
  const roleSelect = <Select name="role" defaultValue="employee">{ROLE_OPTIONS.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)}</Select>;
  const matrix = new Map<string, Set<string>>();
  for (const rp of rolePerms ?? []) {
    const key = (rp.role as unknown as { key: string }).key;
    if (!matrix.has(key)) matrix.set(key, new Set());
    matrix.get(key)!.add(rp.permission_key);
  }
  return (
    <>
      <PageHeader title="Users & permissions" back={{ href: "/admin", label: "Administration" }}
        actions={
          <ModalButton label="Add person" title="Add a person" variant="primary">
            <ActionForm action={inviteUser} className="space-y-3">
              <Field label="Full name"><Input name="full_name" required /></Field>
              <Field label="Email"><Input name="email" type="email" required /></Field>
              <Field label="Temporary password" hint="Only needed for new logins (8+ characters). They can change it after signing in."><Input name="password" type="text" autoComplete="off" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Role">{roleSelect}</Field>
                <Field label="Applies to"><Select name="scope" defaultValue={`location:${ctx.location.id}`}>{scopeOptions}</Select></Field>
              </div>
              <p className="text-xs text-muted">You can only grant roles below your own. Corporate master data (products, recipes, vendors) can only be changed by roles granted company-wide.</p>
              <div className="flex justify-end"><SubmitButton>Add person</SubmitButton></div>
            </ActionForm>
          </ModalButton>
        } />
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Status</th><th /></tr></thead>
            <tbody>
              {(users ?? []).map((u: { user_id: string; full_name: string; email: string; active: boolean; roles: Role[] }) => (
                <tr key={u.user_id} className={!u.active ? "opacity-60" : ""}>
                  <td className="font-medium">{u.full_name}</td>
                  <td>{u.email}</td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r) => (
                        <span key={r.id} className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs">
                          <b>{r.name}</b> · {r.scope_name}
                          {u.user_id !== ctx.user.id ? <ActionButton size="sm" variant="ghost" className="h-5 px-1" action={revokeRole.bind(null, r.id)} confirm={`Remove ${r.name} (${r.scope_name}) from ${u.full_name}?`}>✕</ActionButton> : null}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td>{u.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}</td>
                  <td className="whitespace-nowrap text-right">
                    <ModalButton label="Grant role" title={`Grant a role to ${u.full_name}`} size="sm" variant="ghost">
                      <ActionForm action={grantRole.bind(null, u.user_id)} className="space-y-3">
                        <Field label="Role">{roleSelect}</Field>
                        <Field label="Applies to"><Select name="scope" defaultValue={`location:${ctx.location.id}`}>{scopeOptions}</Select></Field>
                        <div className="flex justify-end"><SubmitButton>Grant</SubmitButton></div>
                      </ActionForm>
                    </ModalButton>
                    {u.user_id !== ctx.user.id ? (
                      <ActionButton size="sm" variant="ghost" action={setMemberActive.bind(null, u.user_id, !u.active)} confirm={u.active ? `Deactivate ${u.full_name}? They immediately lose access to this organization.` : undefined}>
                        {u.active ? "Deactivate" : "Reactivate"}
                      </ActionButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <details className="mt-4 rounded-lg border border-border bg-surface">
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Role permission matrix</summary>
        <div className="overflow-x-auto">
          <table className="tbl text-xs">
            <thead><tr><th>Permission</th>{ROLE_OPTIONS.map((r) => <th key={r.key} className="text-center">{r.name}</th>)}</tr></thead>
            <tbody>
              {(perms ?? []).map((p) => (
                <tr key={p.key}><td title={p.description}><code>{p.key}</code><div className="text-muted">{p.description}</div></td>
                  {ROLE_OPTIONS.map((r) => <td key={r.key} className="text-center">{matrix.get(r.key)?.has(p.key) ? "●" : ""}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
