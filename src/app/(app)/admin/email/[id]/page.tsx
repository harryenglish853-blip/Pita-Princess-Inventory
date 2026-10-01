import { notFound, redirect } from "next/navigation";
import { canOrg, requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, PageHeader } from "@/components/ui";
import { dateTimeFmt } from "@/lib/format";
import { renderEmail } from "@/lib/email/templates";
import { appUrl } from "@/lib/email/dispatch";

export const metadata = { title: "Email preview" };

export default async function EmailPreview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  if (!canOrg(ctx, "settings.manage")) redirect("/denied?perm=settings.manage");
  const supabase = await createClient();
  const { data: row } = await supabase.from("email_outbox").select("*").eq("id", id).maybeSingle();
  if (!row) notFound();
  const r = renderEmail(row, appUrl());
  return (
    <>
      <PageHeader title={r.subject} back={{ href: "/admin/email", label: "Email" }}
        subtitle={<>To {row.recipients.length ? row.recipients.join(", ") : "nobody (no subscribers)"} · created {dateTimeFmt(row.created_at, ctx.location.timezone)} · <Badge>{row.status.toUpperCase()}</Badge></>} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,640px)_1fr]">
        {/* sandboxed: the email HTML cannot run script or reach the app */}
        <iframe title="Email preview" sandbox="" srcDoc={r.html} className="h-[80vh] w-full rounded-lg border border-border bg-white" data-testid="email-preview" />
        <Card title="Plain-text version"><pre className="whitespace-pre-wrap text-xs">{r.text}</pre></Card>
      </div>
    </>
  );
}
