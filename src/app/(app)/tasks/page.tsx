import { requireContext, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, ModalButton, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, PageHeader, Select, TabLinks } from "@/components/ui";
import { dateTimeFmt, todayIn } from "@/lib/format";
import { ackAlert, completeTask, createTask } from "./actions";

export const metadata = { title: "Tasks & alerts" };

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab = "tasks" } = await searchParams;
  const ctx = await requireContext();
  const supabase = await createClient();
  const today = todayIn(ctx.location.timezone);
  const [{ data: tasks }, { data: alerts }, { data: people }] = await Promise.all([
    supabase.from("tasks").select("*, assignee:profiles!tasks_assigned_to_fkey(full_name)").eq("location_id", ctx.location.id).order("due_at").limit(300),
    supabase.from("alerts").select("*").eq("location_id", ctx.location.id).order("created_at", { ascending: false }).limit(200),
    can(ctx, "tasks.manage") ? supabase.rpc("list_org_users", { p_org: ctx.organizationId }) : Promise.resolve({ data: [] }),
  ]);
  const bucket = (t: { status: string; due_at: string }) => {
    if (t.status !== "open") return t.status === "complete" ? "COMPLETE" : "CANCELLED";
    const d = new Date(t.due_at).toLocaleDateString("en-CA", { timeZone: ctx.location.timezone });
    return d < today ? "OVERDUE" : d === today ? "DUE TODAY" : "UPCOMING";
  };
  const order = ["OVERDUE", "DUE TODAY", "UPCOMING", "COMPLETE"];
  const groups = order.map((b) => ({ b, items: (tasks ?? []).filter((t) => bucket(t) === b) }));
  return (
    <>
      <PageHeader title="Tasks & alerts" actions={can(ctx, "tasks.manage") ? (
        <ModalButton label="New task" title="New task" variant="primary">
          <ActionForm action={createTask} className="space-y-3">
            <Field label="Task"><Input name="title" required placeholder="Count liquor" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Due"><Input type="datetime-local" name="due_at" required /></Field>
              <Field label="Repeat"><Select name="recurrence" defaultValue=""><option value="">Once</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field>
              <Field label="Type"><Select name="task_type" defaultValue="custom">{["count", "order", "receive", "review_variance", "review_waste", "invoice", "custom"].map((t) => <option key={t} value={t}>{t.replace("_", " ")}</option>)}</Select></Field>
              <Field label="Assign to"><Select name="assigned_to" defaultValue=""><option value="">Anyone</option>{((people ?? []) as { user_id: string; full_name: string }[]).map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name}</option>)}</Select></Field>
            </div>
            <Field label="Details"><Input name="description" /></Field>
            <SubmitButton>Create task</SubmitButton>
          </ActionForm>
        </ModalButton>
      ) : null} />
      <TabLinks active={tab} tabs={[{ key: "tasks", label: "Tasks", href: "?tab=tasks" }, { key: "alerts", label: `Alerts (${(alerts ?? []).filter((a) => a.status === "open").length})`, href: "?tab=alerts" }]} />
      {tab === "tasks" ? (
        <div className="space-y-4">
          {groups.map(({ b, items }) => (
            <Card key={b} title={<span className="flex items-center gap-2">{b} <Badge tone={b === "OVERDUE" ? "danger" : b === "DUE TODAY" ? "warning" : b === "COMPLETE" ? "success" : "neutral"}>{items.length}</Badge></span>} padded={false}>
              <ul className="divide-y divide-border">
                {items.slice(0, b === "COMPLETE" ? 15 : 100).map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <div>
                      <div className={`text-sm font-medium ${t.status === "complete" ? "text-muted line-through" : ""}`}>{t.title}</div>
                      <div className="text-xs text-muted">Due {dateTimeFmt(t.due_at, ctx.location.timezone)}{t.recurrence ? ` · repeats ${t.recurrence}` : ""}{(t.assignee as { full_name: string } | null)?.full_name ? ` · ${(t.assignee as { full_name: string }).full_name}` : ""}{t.description ? ` · ${t.description}` : ""}</div>
                    </div>
                    {t.status === "open" ? <ActionButton size="sm" variant="secondary" action={completeTask.bind(null, t.id)}>Complete</ActionButton> : null}
                  </li>
                ))}
                {!items.length ? <li className="px-4 py-3 text-sm text-muted">None</li> : null}
              </ul>
            </Card>
          ))}
        </div>
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-border">
            {(alerts ?? []).map((a) => (
              <li key={a.id} className={`flex items-start justify-between gap-3 px-4 py-2.5 ${a.status === "resolved" ? "opacity-60" : ""}`}>
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium"><Badge tone={a.severity === "critical" ? "danger" : a.severity === "warning" ? "warning" : "info"}>{a.alert_type.replace(/_/g, " ")}</Badge>{a.title}</div>
                  <div className="text-xs text-muted">{a.message} · {dateTimeFmt(a.created_at)} · {a.status}</div>
                </div>
                <div className="flex gap-1">
                  {a.status === "open" ? <ActionButton size="sm" variant="ghost" action={ackAlert.bind(null, a.id, false)}>Acknowledge</ActionButton> : null}
                  {a.status !== "resolved" ? <ActionButton size="sm" variant="ghost" action={ackAlert.bind(null, a.id, true)}>Resolve</ActionButton> : null}
                </div>
              </li>
            ))}
            {!alerts?.length ? <li className="px-4 py-6 text-center text-sm text-muted">No alerts</li> : null}
          </ul>
        </Card>
      )}
    </>
  );
}
