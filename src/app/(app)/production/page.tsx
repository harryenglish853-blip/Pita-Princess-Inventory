import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field, Input, PageHeader, Select, EmptyState } from "@/components/ui";
import { DataTable } from "@/components/data-table";
import { qty } from "@/lib/format";
import { recordProduction } from "./actions";

export const metadata = { title: "Prep / production" };

export default async function ProductionPage({ searchParams }: { searchParams: Promise<{ recipe?: string }> }) {
  const sp = await searchParams;
  const ctx = await requirePermission("production.log");
  const supabase = await createClient();
  const [{ data: recipes }, { data: storages }, { data: batches }, { data: prep }] = await Promise.all([
    supabase.from("recipes").select("id, name, yield_qty, unit:units(code)").not("product_id", "is", null).eq("active", true).order("name"),
    supabase.from("storage_locations").select("id, name").eq("location_id", ctx.location.id).eq("active", true).order("sort_order"),
    supabase.from("production_batches").select("id, produced_at, expected_qty, actual_qty, ingredient_cost, notes, recipe:recipes(name), unit:units(code), who:profiles(full_name)")
      .eq("location_id", ctx.location.id).order("produced_at", { ascending: false }).limit(200),
    supabase.rpc("suggested_prep", { p_location: ctx.location.id, p_days: 1, p_safety_days: 0.5 }),
  ]);
  const showCost = can(ctx, "reports.view_cost");
  const rows = (batches ?? []).map((b) => ({
    ...b, recipe_name: (b.recipe as unknown as { name: string }).name, unit_code: (b.unit as unknown as { code: string }).code,
    yield_variance: Number(b.actual_qty) - Number(b.expected_qty), yield_pct: Number(b.expected_qty) ? (Number(b.actual_qty) / Number(b.expected_qty)) * 100 : null,
    by: (b.who as unknown as { full_name: string } | null)?.full_name,
  }));
  return (
    <>
      <PageHeader title="Prep / production" subtitle="Recording a batch depletes the ingredients and adds the prepared item to inventory" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,26rem)_1fr]">
        <Card title="Record a batch">
          {recipes?.length ? (
            <ActionForm action={recordProduction} resetOnSuccess className="space-y-3">
              <input type="hidden" name="client_key" value={crypto.randomUUID()} />
              <Field label="Prep recipe"><Select name="recipe_id" defaultValue={sp.recipe ?? ""} required>
                <option value="" disabled>Choose…</option>{recipes.map((r) => <option key={r.id} value={r.id}>{r.name} (batch {Number(r.yield_qty)} {(r.unit as unknown as { code: string }).code})</option>)}
              </Select></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Expected yield" hint="Ingredients are used for this amount"><Input name="expected_qty" inputMode="decimal" required /></Field>
                <Field label="Actual yield" hint="What you actually got"><Input name="actual_qty" inputMode="decimal" required /></Field>
              </div>
              <Field label="Store in"><Select name="storage_id" defaultValue=""><option value="">—</option>{(storages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <Field label="Notes"><Input name="notes" /></Field>
              <SubmitButton className="w-full" size="lg">Record production</SubmitButton>
            </ActionForm>
          ) : <EmptyState title="No prep recipes">Link a recipe to a prepped inventory item (e.g. Salsa) to record production.</EmptyState>}
        </Card>
        <div className="space-y-4">
          <Card title="Suggested prep (today + ½ day safety)" padded={false}>
            <table className="tbl">
              <thead><tr><th>Item</th><th className="num">Prepared on hand</th><th className="num">Avg daily use</th><th className="num">Need</th><th className="num">Suggested prep</th></tr></thead>
              <tbody>
                {(prep ?? []).map((p: { recipe_id: string; recipe_name: string; unit_code: string; on_hand: number; daily_usage: number; need: number; suggested_qty: number }) => (
                  <tr key={p.recipe_id}><td className="font-medium">{p.recipe_name}</td><td className="num">{qty(p.on_hand, p.unit_code)}</td><td className="num">{qty(p.daily_usage, p.unit_code)}</td>
                    <td className="num">{qty(p.need, p.unit_code)}</td><td className="num font-semibold">{Number(p.suggested_qty) > 0 ? qty(p.suggested_qty, p.unit_code) : "—"}</td></tr>
                ))}
                {!prep?.length ? <tr><td colSpan={5} className="py-6 text-center text-muted">No prep items</td></tr> : null}
              </tbody>
            </table>
            <p className="px-4 py-2 text-xs text-muted">Based on the last 14 days of usage (POS depletion, waste and count variance) of each prepared item.</p>
          </Card>
          <DataTable id="production" rows={rows} exportName="production" columns={[
            { key: "produced_at", label: "When", format: "datetime" },
            { key: "recipe_name", label: "Recipe", filterable: true },
            { key: "expected_qty", label: "Expected", format: "qty", unitKey: "unit_code" },
            { key: "actual_qty", label: "Actual", format: "qty", unitKey: "unit_code" },
            { key: "yield_variance", label: "Yield variance", format: "signedQty", unitKey: "unit_code", negativeRed: true },
            { key: "yield_pct", label: "Yield %", format: "pct" },
            ...(showCost ? [{ key: "ingredient_cost", label: "Ingredient cost", format: "money" as const, total: true }] : []),
            { key: "by", label: "By", filterable: true },
          ]} />
        </div>
      </div>
    </>
  );
}
