import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Card, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/client";
import { saveAssignments } from "../../actions";

export const metadata = { title: "Assign counters" };

type Sheet = {
  session: { id: string; name: string; count_number: string; status: string };
  storages: { id: string; name: string }[];
  lines: { product_id: string; storage_location_id: string | null }[];
  entries: { product_id: string; storage_location_id: string | null }[];
  assignments: { user_id: string; name: string; storage_location_id: string | null }[];
};

export default async function AssignCounters({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requirePermission("inventory.review");
  const supabase = await createClient();
  const [{ data: sheetData, error }, { data: users }] = await Promise.all([
    supabase.rpc("get_count_sheet", { p_session: id }),
    supabase.rpc("count_assignable_users", { p_session: id }),
  ]);
  if (error || !sheetData) notFound();
  const sheet = sheetData as Sheet;
  const locked = ["posted", "cancelled"].includes(sheet.session.status);
  const areas = [
    ...sheet.storages,
    ...(sheet.lines.some((l) => !l.storage_location_id) ? [{ id: "none", name: "Unassigned items" }] : []),
  ];
  const areaKey = (s: string | null) => s ?? "none";
  const stats = new Map(areas.map((a) => {
    const lines = sheet.lines.filter((l) => areaKey(l.storage_location_id) === a.id).length;
    const counted = sheet.entries.filter((e) => areaKey(e.storage_location_id) === a.id).length;
    const who = sheet.assignments.filter((x) => areaKey(x.storage_location_id) === a.id).map((x) => x.name);
    return [a.id, { lines, counted, who }];
  }));
  const assigned = new Set(sheet.assignments.map((a) => `${a.user_id}|${areaKey(a.storage_location_id)}`));
  const counters = (users ?? []) as { user_id: string; full_name: string | null; email: string }[];

  return (
    <>
      <PageHeader title="Assign counters" subtitle={<>{sheet.session.name} · {sheet.session.count_number} <StatusBadge status={sheet.session.status} /></>}
        back={{ href: `/counts/${id}/review`, label: "Review" }} />
      <Card title="Areas">
        <ul className="divide-y divide-border text-sm">
          {areas.map((a) => {
            const s = stats.get(a.id)!;
            return (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`area-${a.name}`}>
                <span className="font-medium">{a.name}</span>
                <span className="text-muted">{s.counted}/{s.lines} counted · {s.who.length ? s.who.join(", ") : <span className="text-warning">nobody assigned</span>}</span>
              </li>
            );
          })}
        </ul>
      </Card>
      <div className="mt-4">
        {locked ? <Notice tone="info" title="This count is closed">Assignments can only be changed on open counts.</Notice> : (
          <ActionForm action={saveAssignments} successMessage="Assignments saved">
            <input type="hidden" name="session_id" value={id} />
            <Card title="Who counts where" actions={<SubmitButton size="sm">Save assignments</SubmitButton>}>
              <p className="mb-3 text-sm text-muted">Counters open the count on their own areas first. Anyone can still count any area.</p>
              <div className="space-y-4">
                {counters.map((u) => (
                  <fieldset key={u.user_id}>
                    <legend className="mb-1 text-sm font-semibold">{u.full_name ?? u.email}</legend>
                    <div className="flex flex-wrap gap-2">
                      {areas.map((a) => (
                        <label key={a.id} className="inline-flex cursor-pointer items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
                          <input type="checkbox" name="a" value={`${u.user_id}|${a.id}`} defaultChecked={assigned.has(`${u.user_id}|${a.id}`)}
                            aria-label={`${u.full_name ?? u.email}: ${a.name}`} />
                          {a.name}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
                {!counters.length ? <p className="text-sm text-muted">Nobody at this location can count yet. Add people in Admin → Users.</p> : null}
              </div>
            </Card>
          </ActionForm>
        )}
      </div>
    </>
  );
}
