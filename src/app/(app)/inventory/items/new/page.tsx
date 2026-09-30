import { redirect } from "next/navigation";
import { requireContext, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field, Input, PageHeader, Select } from "@/components/ui";
import { ProductMasterFields } from "../product-fields";
import { createProduct } from "../../actions";

export const metadata = { title: "New product" };

export default async function NewProductPage() {
  const ctx = await requireContext();
  if (!canOrg(ctx, "products.edit")) redirect("/denied?perm=products.edit");
  const supabase = await createClient();
  const [units, cats, vendors, storages, nextNum] = await Promise.all([
    supabase.from("units").select("id, code, name, dimension").eq("active", true).order("sort"),
    supabase.from("categories").select("id, name, parent_id, level").eq("active", true).order("sort").order("name"),
    supabase.from("vendors").select("id, name").eq("active", true).order("name"),
    supabase.from("storage_locations").select("id, name").eq("location_id", ctx.location.id).eq("active", true).order("sort_order"),
    supabase.from("products").select("product_number").order("product_number", { ascending: false }).limit(1),
  ]);
  const suggested = /^\d+$/.test(nextNum.data?.[0]?.product_number ?? "") ? String(Number(nextNum.data![0].product_number) + 1) : "";
  const unitOptions = (units.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>);
  return (
    <>
      <PageHeader title="New product" back={{ href: "/inventory", label: "Inventory" }} subtitle="Corporate master record. It becomes available at every location." />
      <ActionForm action={createProduct} redirectTo={(d) => `/inventory/items/${(d as { id: string }).id}`} className="space-y-4">
        <Card title="Product">
          <ProductMasterFields product={{ product_number: suggested }} units={units.data ?? []} categories={cats.data ?? []} vendors={(vendors.data ?? []).map((v) => ({ id: v.id, label: v.name }))} />
        </Card>
        <Card title="Units & conversions">
          <p className="mb-3 text-sm text-muted">Inventory is stored in the <b>inventory unit</b>. Example: chicken is counted in LB and purchased by the CASE, 1 CASE = 40 LB.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Inventory unit *"><Select name="inventory_unit_id" required defaultValue="">{[<option key="" value="">Choose…</option>, ...unitOptions]}</Select></Field>
            <Field label="Purchase unit"><Select name="purchase_unit_id" defaultValue=""><option value="">Same as inventory unit</option>{unitOptions}</Select></Field>
            <Field label="Inventory units per purchase unit" hint="e.g. 40 (LB per CASE)"><Input name="purchase_factor" inputMode="decimal" /></Field>
            <Field label="Pack size"><Input name="pack_size" placeholder="4/10 LB" /></Field>
            <Field label="Extra count unit" hint="e.g. BAG"><Select name="count_unit_id" defaultValue=""><option value="">None</option>{unitOptions}</Select></Field>
            <Field label="Inventory units per count unit"><Input name="count_factor" inputMode="decimal" /></Field>
            <Field label="UPC / barcode"><Input name="upc" inputMode="numeric" /></Field>
          </div>
        </Card>
        <Card title={`Vendor & storage at #${ctx.location.code}`}>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Vendor item #" hint="Adds it to the default vendor's order guide"><Input name="vendor_item_number" /></Field>
            <Field label="Vendor price / purchase unit"><Input name="vendor_price" inputMode="decimal" /></Field>
            <Field label="Storage area"><Select name="storage_location_id" defaultValue=""><option value="">Assign later</option>{(storages.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
            <Field label="Shelf"><Input name="shelf" placeholder="Shelf 2" /></Field>
            <Field label="Par (inventory units)"><Input name="par_qty" inputMode="decimal" /></Field>
          </div>
        </Card>
        <div className="flex justify-end"><SubmitButton>Create product</SubmitButton></div>
      </ActionForm>
    </>
  );
}
