import Link from "next/link";
import { requireContext } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, EmptyState, Input, PageHeader } from "@/components/ui";

export const metadata = { title: "Search" };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q = "" } = await searchParams;
  const ctx = await requireContext();
  const supabase = await createClient();
  const { data } = q.trim().length >= 2 ? await supabase.rpc("global_search", { p_q: q, p_location: ctx.location.id }) : { data: [] };
  const results = (data ?? []) as { kind: string; id: string; title: string; subtitle: string; href: string }[];
  const kinds = Array.from(new Set(results.map((r) => r.kind)));
  return (
    <>
      <PageHeader title="Search" subtitle="Products, UPCs, vendor item numbers, vendors, purchase orders, invoices, counts, lots, locations, transactions" />
      <form className="mb-4"><Input name="q" defaultValue={q} autoFocus placeholder="Search…" type="search" aria-label="Search" /></form>
      {q.trim().length >= 2 && !results.length ? <EmptyState title={`Nothing found for “${q}”`} /> : null}
      <div className="space-y-4">
        {kinds.map((k) => (
          <Card key={k} title={k} padded={false}>
            <ul className="divide-y divide-border">
              {results.filter((r) => r.kind === k).map((r) => (
                <li key={r.kind + r.id}><Link href={r.href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-surface-2">
                  <span><span className="font-medium">{r.title}</span><span className="block text-xs text-muted">{r.subtitle}</span></span><Badge>{k}</Badge>
                </Link></li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </>
  );
}
