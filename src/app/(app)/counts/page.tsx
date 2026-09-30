import Link from "next/link";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Card, EmptyState, PageHeader, StatusBadge, LinkButton } from "@/components/ui";
import { dateTimeFmt, money, titleCase } from "@/lib/format";
import { StartCount } from "./start-count";
import { DownloadForOffline } from "./download-offline";

export const metadata = { title: "Physical counts" };

export default async function CountsPage() {
  const ctx = await requirePermission("inventory.count");
  const supabase = await createClient();
  const [{ data: sessions }, { data: storages }, { data: cats }] = await Promise.all([
    supabase.from("count_sessions").select("id, count_number, name, count_type, status, count_at, created_at, submitted_at, posted_at, creator:profiles!count_sessions_created_by_fkey(full_name)")
      .eq("location_id", ctx.location.id).order("count_at", { ascending: false }).limit(60),
    supabase.from("storage_locations").select("id, name").eq("location_id", ctx.location.id).eq("active", true).order("sort_order"),
    supabase.from("categories").select("id, name, level").eq("active", true).order("sort").order("name"),
  ]);
  const ids = (sessions ?? []).map((s) => s.id);
  const openIds = (sessions ?? []).filter((s) => !["posted", "cancelled"].includes(s.status)).map((s) => s.id);
  const [{ data: entries }, { data: items }, { data: posted }] = await Promise.all([
    supabase.from("count_entries").select("session_id").in("session_id", openIds.length ? openIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from("count_session_items").select("session_id, product_id").in("session_id", openIds.length ? openIds : ["00000000-0000-0000-0000-000000000000"]),
    supabase.from("count_posting_lines").select("session_id, variance_value").in("session_id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
  ]);
  const open = (sessions ?? []).filter((s) => !["posted", "cancelled"].includes(s.status));
  const done = (sessions ?? []).filter((s) => ["posted", "cancelled"].includes(s.status));
  const progress = (id: string) => {
    const n = new Set((items ?? []).filter((i) => i.session_id === id).map((i) => i.product_id)).size;
    const c = (entries ?? []).filter((e) => e.session_id === id).length;
    return { n, c };
  };
  const variance = (id: string) => (posted ?? []).filter((p) => p.session_id === id).reduce((s, p) => s + Number(p.variance_value), 0);
  const showCost = can(ctx, "reports.view_cost");
  return (
    <>
      <PageHeader title="Physical counts" subtitle={`#${ctx.location.code} ${ctx.location.name}`}
        actions={<StartCount storages={storages ?? []} categories={cats ?? []} />} />
      <h2 className="mb-2 text-sm font-semibold text-muted">OPEN COUNTS</h2>
      {open.length ? (
        <div className="mb-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {open.map((s) => {
            const p = progress(s.id);
            return (
              <Card key={s.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{s.name}</div>
                    <div className="text-xs text-muted">{s.count_number} · {titleCase(s.count_type)} · as of {dateTimeFmt(s.count_at, ctx.location.timezone)}</div>
                  </div>
                  <StatusBadge status={s.status} />
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={p.c} aria-valuemax={p.n}>
                  <div className="h-full bg-brand" style={{ width: `${p.n ? Math.min(100, (p.c / p.n) * 100) : 0}%` }} />
                </div>
                <div className="mt-1 text-xs text-muted">{p.c} lines counted · {p.n} items on sheet</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {["not_started", "in_progress", "awaiting_review"].includes(s.status) ? <LinkButton href={`/counts/${s.id}`} variant="primary" size="sm">{s.status === "not_started" ? "Start counting" : "Continue count"}</LinkButton> : null}
                  {can(ctx, "inventory.review") ? <LinkButton href={`/counts/${s.id}/review`} size="sm">Review</LinkButton> : null}
                  <DownloadForOffline sessionId={s.id} />
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="mb-6"><EmptyState title="No open counts">Start a count to walk your storage areas in shelf-to-sheet order. Counts keep working without internet.</EmptyState></div>
      )}
      <h2 className="mb-2 text-sm font-semibold text-muted">HISTORY</h2>
      <Card padded={false}>
        <table className="tbl">
          <thead><tr><th>Count</th><th>Type</th><th>As of</th><th>Status</th>{showCost ? <th className="num">Variance</th> : null}<th>By</th></tr></thead>
          <tbody>
            {done.map((s) => (
              <tr key={s.id}>
                <td><Link className="font-medium text-brand" href={`/counts/${s.id}/review`}>{s.name}</Link><div className="text-xs text-muted">{s.count_number}</div></td>
                <td>{titleCase(s.count_type)}</td><td>{dateTimeFmt(s.count_at, ctx.location.timezone)}</td><td><StatusBadge status={s.status} /></td>
                {showCost ? <td className={`num ${variance(s.id) < 0 ? "text-danger" : ""}`}>{s.status === "posted" ? money(variance(s.id)) : "—"}</td> : null}
                <td>{(s.creator as unknown as { full_name: string } | null)?.full_name ?? "—"}</td>
              </tr>
            ))}
            {!done.length ? <tr><td colSpan={6} className="py-6 text-center text-muted">No posted counts yet</td></tr> : null}
          </tbody>
        </table>
      </Card>
    </>
  );
}
