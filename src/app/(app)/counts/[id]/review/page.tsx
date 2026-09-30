import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton } from "@/components/client";
import { Badge, Card, LinkButton, Notice, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { dateTimeFmt, money, pct, qty, signedQty, titleCase } from "@/lib/format";
import { cancelCount, markReviewed, postCount, reopenCount, resolveConflict } from "../../actions";
import { RecountForm } from "./recount-form";

export const metadata = { title: "Inventory review" };

type Line = {
  product_id: string; product_number: string; product_name: string; category_name: string | null; inventory_unit: string; storage_names: string | null;
  counted: boolean; entry_count: number; counted_by_names: string | null; has_conflict: boolean; recount_requested: boolean; recounted: boolean;
  begin_qty: number; received_qty: number; transfer_in_qty: number; transfer_out_qty: number; produced_qty: number; consumed_qty: number;
  waste_qty: number; adjusted_qty: number; in_transit_qty: number; book_qty: number; physical_qty: number | null; variance_qty: number | null;
  unit_cost: number; variance_value: number | null; variance_pct: number | null; exceeds_tolerance: boolean;
};

const SORTS: Record<string, { label: string; fn: (a: Line, b: Line) => number }> = {
  value: { label: "Largest $ variance", fn: (a, b) => Math.abs(b.variance_value ?? 0) - Math.abs(a.variance_value ?? 0) },
  qty: { label: "Largest qty variance", fn: (a, b) => Math.abs(b.variance_qty ?? 0) - Math.abs(a.variance_qty ?? 0) },
  pct: { label: "Largest % variance", fn: (a, b) => Math.abs(b.variance_pct ?? 0) - Math.abs(a.variance_pct ?? 0) },
  category: { label: "Category", fn: (a, b) => (a.category_name ?? "").localeCompare(b.category_name ?? "") || a.product_name.localeCompare(b.product_name) },
  storage: { label: "Storage location", fn: (a, b) => (a.storage_names ?? "~").localeCompare(b.storage_names ?? "~") },
  product: { label: "Product", fn: (a, b) => a.product_name.localeCompare(b.product_name) },
};

export default async function ReviewPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sort?: string; show?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await requirePermission("inventory.count");
  const supabase = await createClient();
  const [{ data: session }, { data: lines, error }, { data: conflicts }, { data: voiceEntries }] = await Promise.all([
    supabase.from("count_sessions").select("*, poster:profiles!count_sessions_posted_by_fkey(full_name)").eq("id", id).single(),
    supabase.rpc("count_review_lines", { p_session: id }),
    supabase.from("count_entries").select("id, product_id, quantity, revision, counted_by, storage:storage_locations(name), product:products(name), who:profiles!count_entries_counted_by_fkey(full_name)").eq("session_id", id).eq("has_conflict", true),
    supabase.from("count_entries").select("id, voice_transcript, voice_confidence, quantity, product:products(name), who:profiles!count_entries_counted_by_fkey(full_name)").eq("session_id", id).eq("method", "voice"),
  ]);
  if (!session) notFound();
  if (error) return <Notice tone="danger">{error.message}</Notice>;
  const revs = conflicts?.length
    ? (await supabase.from("count_entry_revisions").select("id, entry_id, status, quantity, breakdown, counted_at, who:profiles(full_name)").in("entry_id", conflicts.map((c) => c.id)).order("id")).data ?? []
    : [];

  const all = (lines ?? []) as Line[];
  const sortKey = SORTS[sp.sort ?? "value"] ? sp.sort ?? "value" : "value";
  const show = sp.show ?? "all";
  const rows = all.filter((l) => show === "flagged" ? l.exceeds_tolerance : show === "variance" ? (l.variance_qty ?? 0) !== 0 : show === "uncounted" ? !l.counted : true).sort(SORTS[sortKey].fn);
  const showCost = can(ctx, "reports.view_cost");
  const flagged = all.filter((l) => l.exceeds_tolerance);
  const net = all.reduce((s, l) => s + Number(l.variance_value ?? 0), 0);
  const loss = all.reduce((s, l) => s + Math.min(0, Number(l.variance_value ?? 0)), 0);
  const bookValue = all.reduce((s, l) => s + Number(l.book_qty) * Number(l.unit_cost), 0);
  const uncounted = all.filter((l) => !l.counted).length;
  const outstanding = all.filter((l) => l.recount_requested).length;
  const posted = session.status === "posted";
  const canPost = can(ctx, "inventory.post") && ["awaiting_review", "reviewed"].includes(session.status);
  const canReviewPerm = can(ctx, "inventory.review");
  const link = (o: Record<string, string>) => `?${new URLSearchParams({ sort: sortKey, show, ...o })}`;

  return (
    <>
      <PageHeader
        back={{ href: "/counts", label: "Counts" }}
        title={`Inventory review · ${session.name}`}
        subtitle={<><StatusBadge status={session.status} /> {`${session.count_number} · ${titleCase(session.count_type)} · book compared as of ${dateTimeFmt(session.count_at, ctx.location.timezone)}${posted ? ` · posted ${dateTimeFmt(session.posted_at)} by ${(session.poster as { full_name: string } | null)?.full_name ?? ""}` : ""}`}</>}
        actions={
          <>
            {!posted && session.status !== "cancelled" ? <LinkButton href={`/counts/${id}`}>Open count sheet</LinkButton> : null}
            {canReviewPerm && ["awaiting_review", "reviewed"].includes(session.status) ? <ActionButton action={reopenCount.bind(null, id)} confirm="Reopen the count so counters can keep editing?">Reopen</ActionButton> : null}
            {canReviewPerm && session.status === "awaiting_review" ? <ActionButton action={markReviewed.bind(null, id)} disabled={!!conflicts?.length || outstanding > 0}>Mark reviewed</ActionButton> : null}
            {canReviewPerm && !posted && session.status !== "cancelled" ? <ActionButton action={cancelCount.bind(null, id)} variant="ghost" prompt="Why is this count being cancelled?" confirm="Cancel this count? Entries are kept for the audit trail but nothing is posted." confirmLabel="Cancel count">Cancel count</ActionButton> : null}
            {canPost ? (
              <ActionButton variant="primary" action={postCount.bind(null, id, true)} requireText="POST" confirmLabel="Post inventory"
                disabled={!!conflicts?.length || outstanding > 0}
                confirm={<div className="space-y-2">
                  <p className="font-semibold">Post {session.name}?</p>
                  <p>This creates inventory variance transactions as of {dateTimeFmt(session.count_at, ctx.location.timezone)}, updates perpetual inventory and locks the count. It cannot be undone.</p>
                  <ul className="list-disc pl-5 text-muted">
                    <li>{all.length - uncounted} counted items{uncounted ? `, ${uncounted} not counted ${session.zero_uncounted ? "(posted as zero)" : "(skipped)"}` : ""}</li>
                    {showCost ? <li>Net variance {money(net)}</li> : null}
                    {flagged.length ? <li className="text-warning">{flagged.length} item(s) exceed the variance tolerance — posting confirms these variances.</li> : null}
                  </ul>
                </div>}>
                Post inventory
              </ActionButton>
            ) : null}
          </>
        }
      />

      {conflicts?.length ? <div className="mb-3"><Notice tone="danger" title={`${conflicts.length} conflicting count(s)`}>Two people counted the same item and location differently. Choose the correct value below before posting.</Notice></div> : null}
      {outstanding ? <div className="mb-3"><Notice tone="warning" title={`${outstanding} recount(s) outstanding`}>Counters see these items highlighted on their count sheet.</Notice></div> : null}
      {flagged.length && !posted ? <div className="mb-3"><Notice tone="warning" title={`RECOUNT REQUIRED: ${flagged.length} item(s) exceed tolerance`}>Variance above {session.zero_uncounted ? "" : ""}the location tolerance (default: 10% or $50). Request a recount or confirm the variance when posting.</Notice></div> : null}

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Items" value={all.length} sub={`${uncounted} not counted`} />
        {showCost ? <Stat label="Book value" value={money(bookValue)} /> : null}
        {showCost ? <Stat label="Net variance" value={money(net)} tone={net < 0 ? "danger" : undefined} /> : null}
        {showCost ? <Stat label="Losses" value={money(loss)} tone={loss < 0 ? "danger" : undefined} sub={bookValue ? pct((loss / bookValue) * 100) + " of book" : undefined} /> : null}
        <Stat label="Over tolerance" value={flagged.length} tone={flagged.length ? "warning" : undefined} href={link({ show: "flagged" })} />
        <Stat label="Conflicts / recounts" value={`${conflicts?.length ?? 0} / ${outstanding}`} tone={(conflicts?.length || outstanding) ? "danger" : undefined} />
      </div>

      {conflicts?.length && canReviewPerm ? (
        <Card title="Resolve conflicts" className="mb-4">
          <div className="space-y-3">
            {conflicts.map((c) => (
              <div key={c.id} className="rounded-md border border-border p-3">
                <div className="font-medium">{(c.product as unknown as { name: string }).name} · {(c.storage as unknown as { name: string } | null)?.name ?? "Unassigned"}</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {revs.filter((r) => r.entry_id === c.id && r.quantity !== null).map((r) => (
                    <ActionButton key={r.id} size="sm" action={resolveConflict.bind(null, c.id, r.id)} variant={r.status === "conflict" ? "secondary" : "primary"}>
                      Use {qty(r.quantity)} by {(r.who as unknown as { full_name: string } | null)?.full_name} ({r.status === "conflict" ? "rejected write" : "current"}, {dateTimeFmt(r.counted_at)})
                    </ActionButton>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Sort:</span>
        {Object.entries(SORTS).map(([k, s]) => <Link key={k} href={link({ sort: k })} className={`rounded px-2 py-1 ${k === sortKey ? "bg-brand-soft font-medium text-brand" : "text-muted hover:bg-surface-2"}`}>{s.label}</Link>)}
        <span className="ml-3 text-muted">Show:</span>
        {[["all", "All"], ["variance", "With variance"], ["flagged", "Over tolerance"], ["uncounted", "Not counted"]].map(([k, l]) => (
          <Link key={k} href={link({ show: k })} className={`rounded px-2 py-1 ${k === show ? "bg-brand-soft font-medium text-brand" : "text-muted hover:bg-surface-2"}`}>{l}</Link>
        ))}
      </div>

      <RecountForm sessionId={id} enabled={canReviewPerm && !posted && session.status !== "cancelled"}>
        <Card padded={false}>
          <div className="max-h-[70vh] overflow-auto print-full">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8" aria-label="Select" />
                  <th>Product</th><th className="num">Begin</th><th className="num">Received</th><th className="num">Transfers</th><th className="num">Produced</th>
                  <th className="num">Sold / used</th><th className="num">Waste</th><th className="num">Adjusted</th><th className="num">In transit</th>
                  <th className="num">Book</th><th className="num">Physical</th><th className="num">Variance</th><th className="num">Var %</th>
                  {showCost ? <><th className="num">Unit cost</th><th className="num">Var $</th></> : null}
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.product_id} className={l.exceeds_tolerance ? "bg-warning-soft" : undefined}>
                    <td>{!posted ? <input type="checkbox" name="product_ids" value={l.product_id} defaultChecked={l.exceeds_tolerance && !l.recounted} aria-label={`Select ${l.product_name}`} /> : null}</td>
                    <td className="min-w-52">
                      <Link href={`/inventory/items/${l.product_id}?tab=stock`} className="font-medium text-brand">{l.product_name}</Link>
                      <div className="text-[11px] text-muted">{l.category_name ?? "—"} · {l.storage_names ?? "—"}{l.counted_by_names ? ` · ${l.counted_by_names}` : ""}</div>
                      <div className="mt-0.5 flex gap-1">
                        {l.exceeds_tolerance ? <Badge tone="warning">Recount required</Badge> : null}
                        {l.recount_requested ? <Badge tone="info">Recount requested</Badge> : null}
                        {l.recounted ? <Badge tone="success">Recounted</Badge> : null}
                        {l.has_conflict ? <Badge tone="danger">Conflict</Badge> : null}
                        {!l.counted ? <Badge>{session.zero_uncounted ? "Not counted → 0" : "Not counted"}</Badge> : null}
                      </div>
                    </td>
                    <td className="num">{qty(l.begin_qty)}</td>
                    <td className="num">{qty(l.received_qty)}</td>
                    <td className="num">{signedQty(Number(l.transfer_in_qty) + Number(l.transfer_out_qty))}</td>
                    <td className="num">{qty(l.produced_qty)}</td>
                    <td className="num">{qty(l.consumed_qty)}</td>
                    <td className="num">{qty(l.waste_qty)}</td>
                    <td className="num">{signedQty(l.adjusted_qty)}</td>
                    <td className="num">{qty(l.in_transit_qty)}</td>
                    <td className="num font-medium">{qty(l.book_qty, l.inventory_unit)}</td>
                    <td className="num font-medium">{qty(l.physical_qty, l.inventory_unit)}</td>
                    <td className={`num font-semibold ${Number(l.variance_qty) < 0 ? "text-danger" : Number(l.variance_qty) > 0 ? "text-success" : ""}`}>{signedQty(l.variance_qty, l.inventory_unit)}</td>
                    <td className="num">{pct(l.variance_pct, 1, true)}</td>
                    {showCost ? <><td className="num">{money(l.unit_cost, { precise: true })}</td>
                      <td className={`num font-semibold ${Number(l.variance_value) < 0 ? "text-danger" : ""}`}>{money(l.variance_value)}</td></> : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </RecountForm>

      {voiceEntries?.length ? (
        <Card title="Voice counts (transcripts)" className="mt-4">
          <ul className="space-y-1 text-sm">
            {voiceEntries.map((v) => (
              <li key={v.id}><b>{(v.product as unknown as { name: string }).name}</b>: “{v.voice_transcript}” → {qty(v.quantity)} <span className="text-muted">({Math.round(Number(v.voice_confidence ?? 0) * 100)}% · {(v.who as unknown as { full_name: string } | null)?.full_name})</span></li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}
