import { Field, Input, Select, Textarea } from "@/components/ui";

export type Opt = { id: string; label: string };
type Product = Record<string, unknown> | null;

const v = (p: Product, k: string) => (p?.[k] === null || p?.[k] === undefined ? "" : String(p[k]));

export function CategorySelect({ categories, value, name = "category_id" }: { categories: { id: string; name: string; parent_id: string | null; level: number }[]; value?: string; name?: string }) {
  const byParent = (pid: string | null) => categories.filter((c) => c.parent_id === pid);
  const walk = (pid: string | null, depth: number): Opt[] => byParent(pid).flatMap((c) => [{ id: c.id, label: `${"— ".repeat(depth)}${c.name}` }, ...walk(c.id, depth + 1)]);
  return (
    <Select name={name} defaultValue={value ?? ""}>
      <option value="">Uncategorized</option>
      {walk(null, 0).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </Select>
  );
}

/** Corporate master fields shared by the create and edit forms. */
export function ProductMasterFields({ product, units, categories, vendors, disabled }: {
  product: Product; units: { id: string; code: string; name: string; dimension: string }[];
  categories: { id: string; name: string; parent_id: string | null; level: number }[]; vendors: Opt[]; disabled?: boolean;
}) {
  const unitOptions = units.map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>);
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Field label="Product number *"><Input name="product_number" required defaultValue={v(product, "product_number")} /></Field>
      <Field label="Product name *" className="sm:col-span-1 lg:col-span-2"><Input name="name" required defaultValue={v(product, "name")} /></Field>
      <Field label="Category"><CategorySelect categories={categories} value={v(product, "category_id")} /></Field>
      <Field label="Description" className="sm:col-span-2 lg:col-span-4"><Input name="description" defaultValue={v(product, "description")} /></Field>
      <Field label="Recipe unit" hint="Must convert to the inventory unit">
        <Select name="recipe_unit_id" defaultValue={v(product, "recipe_unit_id")}><option value="">—</option>{unitOptions}</Select>
      </Field>
      <Field label="Default vendor">
        <Select name="default_vendor_id" defaultValue={v(product, "default_vendor_id")}><option value="">—</option>{vendors.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
      </Field>
      <Field label="SKU"><Input name="sku" defaultValue={v(product, "sku")} /></Field>
      <Field label="Brand"><Input name="brand" defaultValue={v(product, "brand")} /></Field>
      <Field label="Manufacturer #"><Input name="manufacturer_number" defaultValue={v(product, "manufacturer_number")} /></Field>
      <Field label="GL account"><Input name="gl_account" defaultValue={v(product, "gl_account")} /></Field>
      <Field label="Standard cost / inventory unit"><Input name="standard_cost" inputMode="decimal" defaultValue={v(product, "standard_cost")} /></Field>
      <Field label="Shelf life (days)"><Input name="shelf_life_days" inputMode="numeric" defaultValue={v(product, "shelf_life_days")} /></Field>
      <Field label="Receiving temp min °F"><Input name="receiving_temp_min" inputMode="decimal" defaultValue={v(product, "receiving_temp_min")} /></Field>
      <Field label="Receiving temp max °F" hint="e.g. 41 for refrigerated"><Input name="receiving_temp_max" inputMode="decimal" defaultValue={v(product, "receiving_temp_max")} /></Field>
      <Field label="Image URL" className="sm:col-span-2"><Input name="image_url" type="url" defaultValue={v(product, "image_url")} /></Field>
      <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm sm:col-span-2 lg:col-span-4">
        {[["lot_tracked", "Lot tracking"], ["expiration_tracked", "Expiration tracking"], ["catch_weight", "Catch weight"], ["taxable", "Taxable"], ["is_prepped", "Prepared in-house"]].map(([k, l]) => (
          <label key={k} className="inline-flex items-center gap-2"><input type="checkbox" name={k} defaultChecked={!!product?.[k]} /> {l}</label>
        ))}
      </div>
      <Field label="Notes" className="sm:col-span-2 lg:col-span-4"><Textarea name="notes" defaultValue={v(product, "notes")} /></Field>
    </fieldset>
  );
}
