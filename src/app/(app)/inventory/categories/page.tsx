import { requirePermission, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { CategorySelect } from "../items/product-fields";
import { saveCategory, saveUnit } from "../actions";

export const metadata = { title: "Categories & units" };
const GROUPS = ["food", "beverage", "alcohol", "paper", "supplies", "other"];

export default async function CategoriesPage() {
  const ctx = await requirePermission("inventory.view");
  const edit = canOrg(ctx, "products.edit");
  const supabase = await createClient();
  const [{ data: cats }, { data: units }, { data: counts }] = await Promise.all([
    supabase.from("categories").select("id, name, parent_id, level, gl_account, cost_group, active").order("sort").order("name"),
    supabase.from("units").select("id, code, name, dimension, std_factor, organization_id").order("sort").order("code"),
    supabase.from("products").select("category_id").eq("active", true),
  ]);
  const n = (id: string) => (counts ?? []).filter((p) => p.category_id === id).length;
  const tree = (pid: string | null, depth: number): React.ReactNode[] =>
    (cats ?? []).filter((c) => c.parent_id === pid).flatMap((c) => [
      <tr key={c.id}>
        <td style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }} className={depth === 0 ? "font-semibold" : ""}>{c.name}</td>
        <td>{["Category", "Subcategory", "Microcategory"][c.level - 1]}</td>
        <td><Badge>{c.cost_group}</Badge></td><td>{c.gl_account ?? "—"}</td><td className="num">{n(c.id)}</td>
      </tr>,
      ...tree(c.id, depth + 1),
    ]);
  return (
    <>
      <PageHeader title="Categories & units" back={{ href: "/inventory", label: "Inventory" }} subtitle={edit ? "Corporate master data" : "Corporate master data (read only for your role)"} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Categories" padded={false}>
          <table className="tbl"><thead><tr><th>Name</th><th>Level</th><th>Cost group</th><th>GL</th><th className="num">Items</th></tr></thead><tbody>{tree(null, 0)}</tbody></table>
          {edit ? (
            <ActionForm action={saveCategory} resetOnSuccess className="border-t border-border p-4">
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Parent (for sub/micro category)"><CategorySelect categories={(cats ?? []).filter((c) => c.level < 3)} name="parent_id" /></Field>
                <Field label="Cost group"><Select name="cost_group" defaultValue="food">{GROUPS.map((g) => <option key={g}>{g}</option>)}</Select></Field>
                <Field label="GL account"><Input name="gl_account" /></Field>
              </div>
              <div className="mt-3 flex justify-end"><SubmitButton size="sm">Add category</SubmitButton></div>
            </ActionForm>
          ) : null}
        </Card>
        <Card title="Units of measure" padded={false}>
          <table className="tbl">
            <thead><tr><th>Code</th><th>Name</th><th>Type</th><th className="num">Standard size</th></tr></thead>
            <tbody>
              {(units ?? []).map((u) => (
                <tr key={u.id}><td className="font-mono font-medium">{u.code}</td><td>{u.name} {u.organization_id ? <Badge tone="brand">Custom</Badge> : null}</td><td>{u.dimension}</td>
                  <td className="num">{u.std_factor ? `${Number(u.std_factor).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${u.dimension === "weight" ? "g" : u.dimension === "volume" ? "ml" : "ea"}` : "per product"}</td></tr>
              ))}
            </tbody>
          </table>
          {edit ? (
            <ActionForm action={saveUnit} resetOnSuccess className="border-t border-border p-4">
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label="Code"><Input name="code" required maxLength={16} /></Field>
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Type"><Select name="dimension"><option value="package">Package (per product)</option><option value="weight">Weight</option><option value="volume">Volume</option><option value="count">Count</option></Select></Field>
                <Field label="Size (g / ml / ea)"><Input name="std_factor" inputMode="decimal" /></Field>
              </div>
              <div className="mt-3 flex justify-end"><SubmitButton size="sm">Add unit</SubmitButton></div>
            </ActionForm>
          ) : null}
        </Card>
      </div>
    </>
  );
}
