import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, LinkButton, Notice, PageHeader, cx } from "@/components/ui";
import { setupSteps, type SetupStatus } from "@/lib/setup";

export const metadata = { title: "Getting started" };

export default async function SetupPage() {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("setup_status", { p_location: ctx.location.id });
  if (error) return <Notice tone="danger" title="Could not load setup">{error.message}</Notice>;
  const steps = setupSteps(data as SetupStatus);
  const now = steps.filter((s) => !s.later);
  const done = now.filter((s) => s.done).length;
  return (
    <>
      <PageHeader title="Getting started" subtitle={`#${ctx.location.code} ${ctx.location.name} · ${done} of ${now.length} done before go-live`} />
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={done} aria-valuemax={now.length}>
        <div className="h-full bg-brand" style={{ width: `${(done / now.length) * 100}%` }} />
      </div>
      {[["Before your first count", now], ["Within the first two weeks (for food cost)", steps.filter((s) => s.later)]].map(([title, list]) => (
        <Card key={title as string} title={title as string} padded={false} className="mb-4">
          <ol className="divide-y divide-border">
            {(list as typeof steps).map((s) => (
              <li key={s.key} className="flex items-start gap-3 px-4 py-3" data-testid={`step-${s.key}`} data-done={s.done}>
                {s.done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-label="Done" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-label="To do" />}
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className={cx("font-medium", s.done && "text-muted")}>{s.title}</div>
                    <div className="text-xs text-muted">{s.why}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={s.done ? "success" : "neutral"}>{s.detail}</Badge>
                    <LinkButton href={s.href} size="sm" variant={s.done ? "ghost" : "secondary"}>{s.action}</LinkButton>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      ))}
      <p className="text-sm text-muted">Stuck? Every list exports to CSV, and products can be re-imported any time; matching items are updated, never duplicated. <Link className="text-brand" href="/">Back to Home</Link></p>
    </>
  );
}
