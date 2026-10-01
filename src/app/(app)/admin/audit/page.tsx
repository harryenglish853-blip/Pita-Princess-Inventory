import { requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Card, Input, PageHeader, Select } from "@/components/ui";
import { dateTimeFmt } from "@/lib/format";

export const metadata = { title: "Audit log" };

function diff(oldV: Record<string, unknown> | null, newV: Record<string, unknown> | null) {
  if (!oldV && !newV) return null;
  const keys = Array.from(new Set([...Object.keys(oldV ?? {}), ...Object.keys(newV ?? {})])).filter((k) => !["id", "organization_id", "created_at", "updated_at"].includes(k));
  if (oldV && newV) return keys.slice(0, 8).map((k) => `${k}: ${JSON.stringify(oldV[k] ?? null)} → ${JSON.stringify(newV[k] ?? null)}`);
  return keys.slice(0, 6).map((k) => `${k}: ${JSON.stringify((newV ?? oldV)![k])}`);
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ q?: string; entity?: string; page?: string }> }) {
  const sp = await searchParams;
  const ctx = await requireContext();
  const supabase = await createClient();
  const page = Math.max(0, Number(sp.page ?? 0));
  let q = supabase.from("audit_logs").select("id, created_at, action, entity_type, entity_id, summary, old_value, new_value, device_id, user_agent, ip_address, location_id, employee_id, user_id")
    .order("id", { ascending: false }).range(page * 100, page * 100 + 99);
  if (sp.entity) q = q.eq("entity_type", sp.entity);
  if (sp.q) q = q.or(`summary.ilike.%${sp.q.replace(/[%,()]/g, "")}%,entity_id.eq.${/^[0-9a-f-]{36}$/.test(sp.q) ? sp.q : "00000000-0000-0000-0000-000000000000"}`);
  const { data, error } = await q;
  const empIds = Array.from(new Set((data ?? []).map((a) => a.employee_id).filter(Boolean))) as string[];
  const userIds = Array.from(new Set((data ?? []).map((a) => a.user_id).filter(Boolean))) as string[];
  // audit_logs.user_id is deliberately not a foreign key (entries outlive users), so names are looked up separately
  const [{ data: emps }, { data: users }] = await Promise.all([
    empIds.length ? supabase.rpc("employee_names", { p_ids: empIds }) : Promise.resolve({ data: [] }),
    userIds.length ? supabase.from("profiles").select("id, full_name, email").in("id", userIds) : Promise.resolve({ data: [] }),
  ]);
  const userName = new Map(((users ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((u) => [u.id, u.full_name ?? u.email ?? "Unknown user"]));
  const empName = new Map(((emps ?? []) as { id: string; display_name: string }[]).map((e) => [e.id, e.display_name]));
  const locName = (id: string | null) => { const l = ctx.locations.find((x) => x.id === id); return l ? `#${l.code}` : "—"; };
  return (
    <>
      <PageHeader title="Audit log" back={{ href: "/admin", label: "Administration" }} subtitle="Append-only record of every critical change" />
      <form className="mb-3 flex flex-wrap gap-2">
        <Input name="q" defaultValue={sp.q} placeholder="Search summary…" className="max-w-xs" />
        <Select name="entity" defaultValue={sp.entity ?? ""} className="max-w-xs">
          <option value="">All records</option>
          {["products", "product_units", "location_products", "vendors", "vendor_products", "purchase_orders", "purchase_order_items", "receipts", "receipt_items", "count_session", "count_entry", "inventory", "user", "storage_locations", "storage_location", "categories", "employee", "commissary_order", "toast_order", "email"].map((e) => <option key={e}>{e}</option>)}
        </Select>
        <button className="h-10 rounded-md border border-border-strong px-4 text-sm">Filter</button>
      </form>
      {error ? <p role="alert" className="text-danger">{error.message}</p> : null}
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>When</th><th>Who</th><th>Where</th><th>What</th><th>Change</th><th>Device</th></tr></thead>
            <tbody>
              {(data ?? []).map((a) => (
                <tr key={a.id} className="align-top">
                  <td className="whitespace-nowrap">{dateTimeFmt(a.created_at)}</td>
                  <td>
                    {a.employee_id && empName.get(a.employee_id) ? <div className="font-medium">{empName.get(a.employee_id)}</div> : null}
                    <div className={a.employee_id ? "text-xs text-muted" : ""}>{a.user_id ? userName.get(a.user_id) ?? "Former user" : "System"}</div>
                  </td>
                  <td>{locName(a.location_id)}</td>
                  <td><div className="font-medium">{a.action} · {a.entity_type}</div><div className="text-xs text-muted">{a.summary}</div></td>
                  <td className="max-w-md text-xs"><ul>{diff(a.old_value, a.new_value)?.map((d, i) => <li key={i} className="truncate font-mono" title={d}>{d}</li>)}</ul></td>
                  <td className="max-w-40 truncate text-xs text-muted" title={a.user_agent ?? ""}>{a.device_id ? `Device ${a.device_id.slice(0, 8)}` : "—"}<div>{a.ip_address}</div></td>
                </tr>
              ))}
              {!data?.length ? <tr><td colSpan={6} className="py-8 text-center text-muted">No audit entries visible to you</td></tr> : null}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="mt-3 flex justify-between text-sm">
        {page > 0 ? <a className="text-brand" href={`?page=${page - 1}&q=${sp.q ?? ""}&entity=${sp.entity ?? ""}`}>← Newer</a> : <span />}
        {(data?.length ?? 0) === 100 ? <a className="text-brand" href={`?page=${page + 1}&q=${sp.q ?? ""}&entity=${sp.entity ?? ""}`}>Older →</a> : null}
      </div>
    </>
  );
}
