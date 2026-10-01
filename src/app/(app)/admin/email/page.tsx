import Link from "next/link";
import { redirect } from "next/navigation";
import { canOrg, requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, ModalButton, SubmitButton } from "@/components/client";
import { Badge, Card, EmptyState, Field, Input, Notice, PageHeader, Select } from "@/components/ui";
import { dateTimeFmt } from "@/lib/format";
import { appUrl, emailConfigured } from "@/lib/email/dispatch";
import { generateReport, retryEmail, saveRecipient, sendPendingNow } from "./actions";

export const metadata = { title: "Email" };

type Kind = { key: string; label: string; description: string; category: string };
type Recipient = { id: string; name: string; email: string; location_id: string | null; active: boolean; kinds: string[] };

function RecipientForm({ r, kinds, locations }: { r?: Recipient; kinds: Kind[]; locations: { id: string; code: string; name: string }[] }) {
  return (
    <ActionForm action={saveRecipient.bind(null, r?.id ?? null)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input name="name" defaultValue={r?.name} required /></Field>
        <Field label="Email"><Input name="email" type="email" defaultValue={r?.email} required /></Field>
      </div>
      <Field label="Location">
        <Select name="location_id" defaultValue={r?.location_id ?? ""}>
          <option value="">All locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>#{l.code} {l.name}</option>)}
        </Select>
      </Field>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted">Sends</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {kinds.map((k) => (
            <label key={k.key} className="flex items-start gap-2 rounded-md p-1.5 text-sm hover:bg-surface-2" title={k.description}>
              <input type="checkbox" name="kinds" value={k.key} defaultChecked={r?.kinds.includes(k.key)} className="mt-0.5" />
              <span><span className="font-medium">{k.label}</span><span className="block text-xs text-muted">{k.description}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {r ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={r.active} /> Active</label> : null}
      <div className="flex justify-end"><SubmitButton>{r ? "Save" : "Add recipient"}</SubmitButton></div>
    </ActionForm>
  );
}

export default async function EmailPage() {
  const ctx = await requireContext();
  if (!canOrg(ctx, "settings.manage")) redirect("/denied?perm=settings.manage");
  const supabase = await createClient();
  const [{ data: kinds }, { data: recipients }, { data: subs }, { data: outbox }] = await Promise.all([
    supabase.from("email_kinds").select("key, label, description, category").order("sort"),
    supabase.from("email_recipients").select("id, name, email, location_id, active").eq("organization_id", ctx.organizationId).order("name"),
    supabase.from("email_subscriptions").select("recipient_id, kind").eq("organization_id", ctx.organizationId),
    supabase.from("email_outbox").select("id, kind, subject, status, recipients, attempts, last_error, created_at, sent_at, location_id")
      .eq("organization_id", ctx.organizationId).order("created_at", { ascending: false }).limit(100),
  ]);
  const cfg = emailConfigured();
  const rec: Recipient[] = (recipients ?? []).map((r) => ({ ...r, kinds: (subs ?? []).filter((s) => s.recipient_id === r.id).map((s) => s.kind) }));
  const kindLabel = new Map((kinds ?? []).map((k) => [k.key, k.label]));
  const locs = ctx.locations.map((l) => ({ id: l.id, code: l.code, name: l.name }));
  const pending = (outbox ?? []).filter((o) => o.status === "pending").length;
  return (
    <>
      <PageHeader title="Email reports & alerts" back={{ href: "/admin", label: "Administration" }}
        subtitle="Who gets which report or alert. Reports are built from stored data at send time and kept here, so you can preview exactly what was sent."
        actions={<ModalButton label="Add recipient" title="Add recipient" variant="primary" wide><RecipientForm kinds={(kinds ?? []) as Kind[]} locations={locs} /></ModalButton>} />

      <Card title="Setup" className="mb-4">
        <ul className="space-y-1 text-sm" data-testid="email-setup">
          <li>{cfg.ok ? <Badge tone="success">READY</Badge> : <Badge tone="danger">NOT SET UP</Badge>} Sending through Resend {cfg.ok ? "" : `— missing ${cfg.missing.join(", ")}`}</li>
          <li>{process.env.CRON_SECRET ? <Badge tone="success">READY</Badge> : <Badge tone="warning">NOT SET UP</Badge>} Schedule (every 15 minutes) {process.env.CRON_SECRET ? "" : "— set CRON_SECRET and deploy with vercel.json"}</li>
          <li><Badge tone="info">LINKS</Badge> Buttons in emails open <code>{appUrl()}</code> {process.env.APP_URL ? "" : "(set APP_URL to your address)"}</li>
        </ul>
        {!cfg.ok ? <p className="mt-2 text-xs text-muted">Until sending is set up, emails are still created and listed below (status Pending), and you can preview every one.</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <ActionButton action={generateReport.bind(null, "daily_report")}>Generate daily report</ActionButton>
          <ActionButton action={generateReport.bind(null, "weekly_report")}>Generate weekly report</ActionButton>
          <ActionButton action={generateReport.bind(null, "monthly_report")}>Generate monthly report</ActionButton>
          {cfg.ok && pending ? <ActionButton variant="primary" action={sendPendingNow}>Send {pending} pending now</ActionButton> : null}
        </div>
        <p className="mt-2 text-xs text-muted">Generated reports use #{ctx.location.code} {ctx.location.name} (change store at the top).</p>
      </Card>

      <Card title="Recipients" padded={false} className="mb-4">
        {!rec.length ? <div className="p-4"><EmptyState title="No recipients yet">Nothing is emailed until you add people and choose what they get.</EmptyState></div> : (
          <table className="tbl">
            <thead><tr><th>Name</th><th>Location</th><th>Gets</th><th /></tr></thead>
            <tbody>{rec.map((r) => (
              <tr key={r.id} className={!r.active ? "opacity-60" : ""}>
                <td><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{r.email}</div></td>
                <td>{r.location_id ? locs.find((l) => l.id === r.location_id)?.code ? `#${locs.find((l) => l.id === r.location_id)!.code}` : "—" : "All"}</td>
                <td><div className="flex flex-wrap gap-1">{r.kinds.length ? r.kinds.map((k) => <Badge key={k}>{kindLabel.get(k) ?? k}</Badge>) : <span className="text-xs text-muted">Nothing</span>}
                  {!r.active ? <Badge tone="danger">Inactive</Badge> : null}</div></td>
                <td className="text-right"><ModalButton label="Edit" title={`Edit ${r.name}`} size="sm" variant="ghost" wide><RecipientForm r={r} kinds={(kinds ?? []) as Kind[]} locations={locs} /></ModalButton></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Card>

      <Card title="Recent emails" padded={false}>
        {!outbox?.length ? <div className="p-4"><EmptyState title="No emails yet" /></div> : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Created</th><th>Email</th><th>To</th><th>Status</th><th /></tr></thead>
              <tbody>{outbox.map((o) => (
                <tr key={o.id} className="align-top">
                  <td className="whitespace-nowrap">{dateTimeFmt(o.created_at, ctx.location.timezone)}</td>
                  <td><div className="font-medium">{o.subject}</div><div className="text-xs text-muted">{kindLabel.get(o.kind) ?? o.kind}</div></td>
                  <td className="max-w-56 text-xs">{o.recipients.length ? o.recipients.join(", ") : "—"}</td>
                  <td><Badge tone={o.status === "sent" ? "success" : o.status === "failed" ? "danger" : o.status === "skipped" ? "neutral" : "info"}>{o.status.toUpperCase()}</Badge>
                    {o.last_error ? <div className="mt-1 max-w-56 text-xs text-muted">{o.last_error}</div> : null}
                    {o.sent_at ? <div className="text-xs text-muted">{dateTimeFmt(o.sent_at, ctx.location.timezone)}</div> : null}</td>
                  <td className="whitespace-nowrap text-right">
                    <Link href={`/admin/email/${o.id}`} className="text-sm text-brand">Preview</Link>
                    {["failed", "skipped"].includes(o.status) ? <ActionButton size="sm" variant="ghost" action={retryEmail.bind(null, o.id)}>Retry</ActionButton> : null}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>
      {!cfg.ok ? <div className="mt-4"><Notice tone="warning" title="BLOCKED — REQUIRES EXTERNAL CONFIGURATION">Create a Resend account, verify your sending domain, then set RESEND_API_KEY, EMAIL_FROM (e.g. “Pita Princess &lt;reports@yourdomain.com&gt;”), APP_URL and CRON_SECRET in Vercel. See DEPLOY.md.</Notice></div> : null}
    </>
  );
}
