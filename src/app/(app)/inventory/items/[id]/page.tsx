import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionButton, ActionForm, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, PageHeader, Select, Stat, StatusBadge, TabLinks, Textarea, Notice } from "@/components/ui";
import { PriceChart } from "@/components/price-chart";
import { money, qty, dateTimeFmt, dateFmt, pct, titleCase, signedQty } from "@/lib/format";
import { ProductMasterFields } from "../product-fields";
import {
  addBarcode, addProductUnit, adjustInventory, removeBarcode, removeProductUnit, setProductActive,
  updateLocalSettings, updateProduct, updateProductUnit, upsertVendorItem,
} from "../../actions";

const TXN_LABEL: Record<string, string> = {
  BEGINNING: "Opening balance", RECEIPT: "Receipt", POS_CONSUMPTION: "POS consumption", RECIPE_CONSUMPTION: "Recipe consumption",
  PRODUCTION: "Production", WASTE: "Waste", TRANSFER_IN: "Transfer in", TRANSFER_OUT: "Transfer out",
  MANUAL_ADJUSTMENT: "Adjustment", PHYSICAL_VARIANCE: "Inventory variance", RETURN_TO_VENDOR: "Return to vendor", CORRECTION: "Correction",
};

export default async function ItemPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string; from?: string; to?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const tab = sp.tab ?? "overview";
  const ctx = await requirePermission("inventory.view");
  const supabase = await createClient();
  const loc = ctx.location.id;

  const [{ data: product }, { data: lp }, { data: inv }, { data: options }] = await Promise.all([
    supabase.from("products").select("*, category:categories(name), inv_unit:units!products_inventory_unit_id_fkey(code, name)").eq("id", id).single(),
    supabase.from("location_products").select("*").eq("location_id", loc).eq("product_id", id).maybeSingle(),
    supabase.from("current_inventory").select("on_hand, unit_cost, extended_value, stock_status, effective_par").eq("location_id", loc).eq("product_id", id).maybeSingle(),
    supabase.from("product_unit_options").select("unit_id, unit_code, unit_name, factor, is_inventory_unit, use_for_count, use_for_purchase, label, priority").eq("product_id", id).order("factor", { ascending: false }),
  ]);
  if (!product) notFound();
  const unit = (product.inv_unit as { code: string }).code;
  const showCost = can(ctx, "reports.view_cost");
  const editMaster = canOrg(ctx, "products.edit");
  const editLocal = can(ctx, "products.local_edit") || can(ctx, "inventory.settings");

  const tabs = [
    { key: "overview", label: "Overview", href: `?tab=overview` },
    { key: "stock", label: "Stock card", href: `?tab=stock` },
    { key: "master", label: "Product master", href: `?tab=master` },
    { key: "units", label: "Units", href: `?tab=units` },
    { key: "vendors", label: "Vendors & prices", href: `?tab=vendors` },
    { key: "barcodes", label: "Barcodes", href: `?tab=barcodes` },
    ...(can(ctx, "inventory.adjust") ? [{ key: "adjust", label: "Adjust", href: `?tab=adjust` }] : []),
  ];

  return (
    <>
      <PageHeader
        back={{ href: "/inventory", label: "Inventory" }}
        title={<span className="flex items-center gap-2">{product.name} {!product.active ? <Badge tone="danger">Inactive</Badge> : null}</span>}
        subtitle={`#${product.product_number} · ${(product.category as { name: string } | null)?.name ?? "Uncategorized"} · Inventory unit ${unit}`}
        actions={editMaster ? (
          <ActionButton action={setProductActive.bind(null, id, !product.active)} variant={product.active ? "secondary" : "primary"}
            confirm={product.active ? "Deactivate this product for every location? History is kept." : undefined}>
            {product.active ? "Deactivate" : "Reactivate"}
          </ActionButton>
        ) : null}
      />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        <Stat label="On hand (book)" value={qty(inv?.on_hand, unit)} tone={Number(inv?.on_hand) < 0 ? "danger" : undefined} />
        <Stat label="Status" value={<StatusBadge status={inv?.stock_status ?? "ok"} />} />
        <Stat label="Par" value={qty(inv?.effective_par, unit)} sub={lp ? titleCase(lp.par_mode) : undefined} />
        {showCost ? <Stat label="Avg cost" value={money(lp?.avg_cost, { precise: true })} sub={`per ${unit}`} /> : null}
        {showCost ? <Stat label="Last cost" value={money(lp?.last_cost, { precise: true })} sub={lp?.last_cost_at ? dateFmt(lp.last_cost_at) : "No receipts"} /> : null}
        {showCost ? <Stat label="Value" value={money(inv?.extended_value)} /> : null}
      </div>
      {Number(inv?.on_hand) < 0 ? (
        <div className="mb-4"><Notice tone="danger" title="Negative book inventory">
          The ledger shows less than zero. Likely causes: a missing receipt, an incorrect recipe, a missing production entry, a wrong unit conversion, an unrecorded transfer or a bad count. Review the stock card below.
        </Notice></div>
      ) : null}
      <TabLinks tabs={tabs} active={tab} />

      {tab === "overview" ? <Overview id={id} lp={lp} unit={unit} editLocal={editLocal} showCost={showCost} ctxLoc={loc} /> : null}
      {tab === "stock" ? <StockCard id={id} loc={loc} unit={unit} from={sp.from} to={sp.to} showCost={showCost} /> : null}
      {tab === "master" ? (
        <MasterTab product={product} editMaster={editMaster} />
      ) : null}
      {tab === "units" ? <UnitsTab product={product} options={options ?? []} editMaster={editMaster} unit={unit} /> : null}
      {tab === "vendors" ? <VendorsTab product={product} unit={unit} options={options ?? []} loc={loc} showCost={showCost} /> : null}
      {tab === "barcodes" ? <BarcodesTab product={product} options={options ?? []} canEdit={editMaster || can(ctx, "inventory.settings")} /> : null}
      {tab === "adjust" && can(ctx, "inventory.adjust") ? <AdjustTab product={product} options={options ?? []} loc={loc} unit={unit} onHand={inv?.on_hand} /> : null}
    </>
  );
}

async function Overview({ id, lp, unit, editLocal, showCost, ctxLoc }: { id: string; lp: Record<string, unknown> | null; unit: string; editLocal: boolean; showCost: boolean; ctxLoc: string }) {
  const supabase = await createClient();
  const [{ data: placements }, { data: vendors }, { data: lastCount }, { data: recent }] = await Promise.all([
    supabase.from("product_storage_locations").select("id, shelf, sort_order, active, storage:storage_locations(name, sort_order)").eq("product_id", id).eq("location_id", ctxLoc).eq("active", true),
    supabase.from("vendors").select("id, name").eq("active", true).order("name"),
    supabase.from("count_entries").select("quantity, counted_at, storage_location_id, storage:storage_locations(name), session:count_sessions!inner(status, count_at, name)")
      .eq("product_id", id).eq("location_id", ctxLoc).eq("session.status", "posted").order("counted_at", { ascending: false }).limit(20),
    supabase.from("inventory_transactions").select("txn_type, quantity, txn_at, reference").eq("product_id", id).eq("location_id", ctxLoc).order("txn_at", { ascending: false }).limit(8),
  ]);
  // Storage distribution as of the most recent posted count
  const latestAt = (lastCount?.[0]?.session as unknown as { count_at: string } | undefined)?.count_at;
  const dist = (lastCount ?? []).filter((c) => (c.session as unknown as { count_at: string }).count_at === latestAt);
  const total = dist.reduce((s, d) => s + Number(d.quantity), 0);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Storage locations">
        {placements?.length ? (
          <table className="tbl">
            <thead><tr><th>Storage area</th><th>Shelf</th><th className="num">Last count</th></tr></thead>
            <tbody>
              {placements.map((p) => {
                const storage = p.storage as unknown as { name: string };
                const counted = dist.find((d) => (d.storage as unknown as { name: string } | null)?.name === storage.name);
                return (
                  <tr key={p.id}><td>{storage.name}</td><td>{p.shelf ?? "—"}</td><td className="num">{counted ? qty(counted.quantity, unit) : "—"}</td></tr>
                );
              })}
              {latestAt ? <tr className="font-semibold"><td colSpan={2}>Total at last count ({dateFmt(latestAt)})</td><td className="num">{qty(total, unit)}</td></tr> : null}
            </tbody>
          </table>
        ) : <p className="text-sm text-muted">Not assigned to a storage area. <Link className="text-brand" href="/inventory/storage">Assign on the shelf-to-sheet screen</Link>.</p>}
      </Card>
      <Card title="Local settings (this restaurant)">
        {lp ? (
          <ActionForm action={updateLocalSettings.bind(null, lp.id as string)} successMessage="Saved">
            <fieldset disabled={!editLocal} className="grid grid-cols-2 gap-3">
              <Field label="Par type">
                <Select name="par_mode" defaultValue={String(lp.par_mode)}>
                  <option value="static">Static par</option><option value="dynamic">Dynamic par (forecast)</option><option value="none">No par</option>
                </Select>
              </Field>
              <Field label={`Static par (${unit})`}><Input name="par_qty" inputMode="decimal" defaultValue={String(lp.par_qty ?? "")} /></Field>
              <Field label={`Minimum (${unit})`}><Input name="min_qty" inputMode="decimal" defaultValue={String(lp.min_qty ?? "")} /></Field>
              <Field label={`Reorder point (${unit})`}><Input name="reorder_point" inputMode="decimal" defaultValue={String(lp.reorder_point ?? "")} /></Field>
              <Field label={`Safety stock (${unit})`}><Input name="safety_stock_qty" inputMode="decimal" defaultValue={String(lp.safety_stock_qty ?? "")} /></Field>
              <Field label="…or safety stock (days of usage)"><Input name="safety_stock_days" inputMode="decimal" defaultValue={String(lp.safety_stock_days ?? "")} /></Field>
              <Field label="Local vendor override" className="col-span-2">
                <Select name="local_vendor_id" defaultValue={String(lp.local_vendor_id ?? "")}><option value="">Use corporate default</option>{(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
              </Field>
              <div className="col-span-2 flex flex-wrap gap-4 text-sm">
                <label className="inline-flex items-center gap-2"><input type="checkbox" name="count_daily" defaultChecked={!!lp.count_daily} /> On daily count</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" name="count_weekly" defaultChecked={!!lp.count_weekly} /> On weekly count</label>
                <label className="inline-flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={!!lp.active} /> Carried at this location</label>
              </div>
              {lp.par_mode === "dynamic" ? (
                <p className="col-span-2 text-xs text-muted">Dynamic par: {lp.dynamic_par_qty ? `${qty(lp.dynamic_par_qty as number, unit)} (calculated ${dateTimeFmt(lp.dynamic_par_at as string)})` : "calculated from forecast demand when orders are suggested"}.</p>
              ) : null}
            </fieldset>
            {editLocal ? <div className="mt-3 flex justify-end"><SubmitButton size="sm">Save local settings</SubmitButton></div> : null}
          </ActionForm>
        ) : <p className="text-sm text-muted">Not carried at this location.</p>}
      </Card>
      <Card title="Recent movements" actions={<Link href="?tab=stock" className="text-sm text-brand">Full stock card</Link>} className="lg:col-span-2">
        <table className="tbl">
          <thead><tr><th>When</th><th>Type</th><th>Reference</th><th className="num">Quantity</th></tr></thead>
          <tbody>
            {(recent ?? []).map((t, i) => (
              <tr key={i}><td>{dateTimeFmt(t.txn_at)}</td><td>{TXN_LABEL[t.txn_type] ?? t.txn_type}</td><td>{t.reference ?? "—"}</td>
                <td className={`num ${Number(t.quantity) < 0 ? "text-danger" : ""}`}>{signedQty(t.quantity, unit)}</td></tr>
            ))}
            {!recent?.length ? <tr><td colSpan={4} className="text-center text-muted">No transactions yet</td></tr> : null}
          </tbody>
        </table>
        {!showCost ? null : null}
      </Card>
    </div>
  );
}

async function StockCard({ id, loc, unit, from, to, showCost }: { id: string; loc: string; unit: string; from?: string; to?: string; showCost: boolean }) {
  const supabase = await createClient();
  const fromD = from ?? new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const toD = to ?? new Date().toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("stock_card", { p_location: loc, p_product: id, p_from: `${fromD}T00:00:00`, p_to: `${toD}T23:59:59.999` });
  if (error) return <Notice tone="danger">{error.message}</Notice>;
  const rows = (data ?? []) as Record<string, unknown>[];
  const last = rows[rows.length - 1];
  return (
    <Card title="Stock card" actions={
      <form className="flex items-end gap-2">
        <input type="hidden" name="tab" value="stock" />
        <Input type="date" name="from" defaultValue={fromD} className="h-8 w-36" aria-label="From" />
        <Input type="date" name="to" defaultValue={toD} className="h-8 w-36" aria-label="To" />
        <button className="h-8 rounded-md border border-border-strong px-3 text-sm">Apply</button>
      </form>
    } padded={false}>
      <div className="overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Date</th><th>Transaction</th><th>Reference</th><th>Storage</th><th>By</th><th className="num">Qty</th><th className="num">Balance</th>{showCost ? <><th className="num">Unit cost</th><th className="num">Value</th><th className="num">Balance value</th></> : null}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className={r.is_opening ? "bg-surface-2 font-medium" : ""}>
                <td className="whitespace-nowrap">{dateTimeFmt(r.txn_at as string)}</td>
                <td>{TXN_LABEL[r.txn_type as string] ?? String(r.txn_type)}{r.reason_code ? <span className="text-muted"> · {titleCase(String(r.reason_code).toLowerCase())}</span> : null}</td>
                <td>{(r.reference as string) ?? (r.notes as string) ?? "—"}</td>
                <td>{(r.storage_name as string) ?? "—"}</td>
                <td>{(r.created_by_name as string) ?? "—"}</td>
                <td className={`num ${Number(r.quantity) < 0 ? "text-danger" : ""}`}>{r.is_opening ? qty(r.quantity as number) : signedQty(r.quantity as number)}</td>
                <td className="num font-medium">{qty(r.running_qty as number, unit)}</td>
                {showCost ? <><td className="num">{money(r.unit_cost as number, { precise: true })}</td><td className="num">{money(r.extended_cost as number)}</td><td className="num">{money(r.running_value as number)}</td></> : null}
              </tr>
            ))}
            {last ? (
              <tr className="font-semibold"><td colSpan={6}>Ending balance</td><td className="num">{qty(last.running_qty as number, unit)}</td>{showCost ? <><td /><td /><td className="num">{money(last.running_value as number)}</td></> : null}</tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

async function MasterTab({ product, editMaster }: { product: Record<string, unknown>; editMaster: boolean }) {
  const supabase = await createClient();
  const [units, cats, vendors] = await Promise.all([
    supabase.from("units").select("id, code, name, dimension").eq("active", true).order("sort"),
    supabase.from("categories").select("id, name, parent_id, level").eq("active", true).order("sort").order("name"),
    supabase.from("vendors").select("id, name").eq("active", true).order("name"),
  ]);
  return (
    <Card title="Corporate product master">
      {!editMaster ? <div className="mb-3"><Notice tone="info">Corporate master data is read-only for your role. Local settings (par, local vendor, storage) are on the Overview tab.</Notice></div> : null}
      <ActionForm action={updateProduct.bind(null, product.id as string)}>
        <input type="hidden" name="purchase_unit_id" value={String(product.purchase_unit_id ?? "")} />
        <ProductMasterFields product={product} units={units.data ?? []} categories={cats.data ?? []} vendors={(vendors.data ?? []).map((v) => ({ id: v.id, label: v.name }))} disabled={!editMaster} />
        {editMaster ? <div className="mt-4 flex justify-end"><SubmitButton>Save product</SubmitButton></div> : null}
      </ActionForm>
    </Card>
  );
}

async function UnitsTab({ product, options, editMaster, unit }: { product: Record<string, unknown>; options: Record<string, unknown>[]; editMaster: boolean; unit: string }) {
  const supabase = await createClient();
  const [{ data: pus }, { data: units }] = await Promise.all([
    supabase.from("product_units").select("id, unit_id, factor, label, use_for_count, use_for_purchase, unit:units(code, name)").eq("product_id", product.id as string).order("factor", { ascending: false }),
    supabase.from("units").select("id, code, name, dimension").eq("active", true).order("sort"),
  ]);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Product-specific conversions">
        <p className="mb-3 text-sm text-muted">1 unit = factor × {unit}. Standard weight/volume units convert automatically.</p>
        <div className="space-y-2">
          {(pus ?? []).map((pu) => {
            const u = pu.unit as unknown as { code: string };
            return (
              <ActionForm key={pu.id} action={updateProductUnit.bind(null, pu.id)} className="rounded-md border border-border p-3">
                <fieldset disabled={!editMaster} className="flex flex-wrap items-end gap-2">
                  <div className="w-20 pb-2 font-semibold">1 {u.code} =</div>
                  <Field label={`${unit}`} className="w-28"><Input name="factor" inputMode="decimal" defaultValue={String(pu.factor)} /></Field>
                  <Field label="Label" className="min-w-32 flex-1"><Input name="label" defaultValue={pu.label ?? ""} /></Field>
                  <label className="inline-flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="use_for_count" defaultChecked={pu.use_for_count} /> Count</label>
                  <label className="inline-flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="use_for_purchase" defaultChecked={pu.use_for_purchase} /> Purchase</label>
                  {editMaster ? <SubmitButton size="sm" variant="secondary">Save</SubmitButton> : null}
                  {editMaster ? <ActionButton size="sm" variant="ghost" action={removeProductUnit.bind(null, pu.id)} confirm={`Remove the ${u.code} conversion? Counts and orders that used it keep their history.`}>Remove</ActionButton> : null}
                </fieldset>
              </ActionForm>
            );
          })}
          {!pus?.length ? <p className="text-sm text-muted">No package conversions yet.</p> : null}
        </div>
        {editMaster ? (
          <ActionForm action={addProductUnit.bind(null, product.id as string, product.organization_id as string)} resetOnSuccess className="mt-4 border-t border-border pt-4">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Unit" className="w-40"><Select name="unit_id" required>{(units ?? []).filter((u) => u.id !== product.inventory_unit_id).map((u) => <option key={u.id} value={u.id}>{u.code} — {u.name}</option>)}</Select></Field>
              <Field label={`= ${unit}`} className="w-28"><Input name="factor" inputMode="decimal" required /></Field>
              <Field label="Label" className="w-40"><Input name="label" placeholder="Case (4 x 10 LB)" /></Field>
              <label className="inline-flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="use_for_count" defaultChecked /> Count</label>
              <label className="inline-flex items-center gap-1 pb-2 text-sm"><input type="checkbox" name="use_for_purchase" /> Purchase</label>
              <SubmitButton size="sm">Add conversion</SubmitButton>
            </div>
          </ActionForm>
        ) : null}
      </Card>
      <Card title="All available units (conversion engine)">
        <table className="tbl">
          <thead><tr><th>Unit</th><th className="num">= {unit}</th><th>Source</th><th>Use</th></tr></thead>
          <tbody>
            {options.map((o) => (
              <tr key={o.unit_id as string}>
                <td className="font-medium">{o.unit_code as string} <span className="text-muted">{o.unit_name as string}</span></td>
                <td className="num">{Number(o.factor).toLocaleString("en-US", { maximumFractionDigits: 6 })}</td>
                <td>{o.is_inventory_unit ? <Badge tone="brand">Inventory unit</Badge> : Number(o.priority) === 1 ? "Product conversion" : "Standard"}</td>
                <td className="text-xs text-muted">{[o.use_for_count && "count", o.use_for_purchase && "purchase", product.recipe_unit_id === o.unit_id && "recipe"].filter(Boolean).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

async function VendorsTab({ product, unit, options, loc, showCost }: { product: Record<string, unknown>; unit: string; options: Record<string, unknown>[]; loc: string; showCost: boolean }) {
  const supabase = await createClient();
  const [{ data: vps }, { data: vendors }, { data: history }] = await Promise.all([
    supabase.from("vendor_products").select("*, vendor:vendors(name), unit:units(code)").eq("product_id", product.id as string).order("is_preferred", { ascending: false }),
    supabase.from("vendors").select("id, name").eq("active", true).order("name"),
    supabase.from("price_history").select("effective_at, unit_price, base_unit_price, vendor:vendors(name), unit:units(code)").eq("product_id", product.id as string).eq("location_id", loc).order("effective_at"),
  ]);
  const purchasable = options.filter((o) => o.use_for_purchase || o.is_inventory_unit || Number(o.priority) === 1);
  const factor = (unitId: string) => Number(options.find((o) => o.unit_id === unitId)?.factor ?? 0);
  const hist = history ?? [];
  const first = hist[0]; const lastH = hist[hist.length - 1]; const prev = hist[hist.length - 2];
  return (
    <div className="space-y-4">
      <Card title="Vendor comparison" padded={false}>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Vendor</th><th>Item #</th><th>Pack</th><th>Unit</th><th className="num">Price</th><th className="num">Contract</th><th className="num">Per {unit}</th><th /></tr></thead>
            <tbody>
              {(vps ?? []).map((vp) => {
                const eff = vp.contract_price && (!vp.contract_end || vp.contract_end >= new Date().toISOString().slice(0, 10)) ? Number(vp.contract_price) : Number(vp.current_price);
                const per = factor(vp.purchase_unit_id) ? eff / factor(vp.purchase_unit_id) : null;
                const best = Math.min(...(vps ?? []).map((x) => { const e = Number(x.contract_price ?? x.current_price); const f = factor(x.purchase_unit_id); return f ? e / f : Infinity; }));
                return (
                  <tr key={vp.id} className={!vp.active ? "opacity-50" : ""}>
                    <td className="font-medium">{(vp.vendor as { name: string }).name} {vp.is_preferred ? <Badge tone="brand">Preferred</Badge> : null} {product.default_vendor_id === vp.vendor_id ? <Badge>Default</Badge> : null}</td>
                    <td>{vp.vendor_item_number}</td><td>{vp.pack_size ?? "—"}</td><td>{(vp.unit as { code: string }).code}</td>
                    <td className="num">{showCost ? money(vp.current_price) : "—"}</td>
                    <td className="num">{showCost && vp.contract_price ? `${money(vp.contract_price)}${vp.contract_end ? ` to ${dateFmt(vp.contract_end)}` : ""}` : "—"}</td>
                    <td className="num">{showCost && per !== null ? <span className={per === best && (vps?.length ?? 0) > 1 ? "font-semibold text-success" : ""}>{money(per, { precise: true })}</span> : "—"}</td>
                    <td><Link className="text-sm text-brand" href={`/vendors/${vp.vendor_id}`}>Order guide</Link></td>
                  </tr>
                );
              })}
              {!vps?.length ? <tr><td colSpan={8} className="text-center text-muted">Not on any vendor order guide</td></tr> : null}
            </tbody>
          </table>
        </div>
        <details className="border-t border-border p-4">
          <summary className="cursor-pointer text-sm font-medium text-brand">Add this product to a vendor&apos;s order guide</summary>
          <ActionForm action={upsertVendorItem.bind(null, product.id as string, product.organization_id as string, null)} resetOnSuccess className="mt-3">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Field label="Vendor"><Select name="vendor_id" required>{(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
              <Field label="Vendor item #"><Input name="vendor_item_number" required /></Field>
              <Field label="Purchase unit"><Select name="purchase_unit_id" required>{purchasable.map((o) => <option key={o.unit_id as string} value={o.unit_id as string}>{o.unit_code as string}</option>)}</Select></Field>
              <Field label="Pack size"><Input name="pack_size" /></Field>
              <Field label="Price"><Input name="current_price" inputMode="decimal" required /></Field>
              <Field label="Contract price"><Input name="contract_price" inputMode="decimal" /></Field>
            </div>
            <div className="mt-3 flex justify-end"><SubmitButton size="sm">Add vendor item</SubmitButton></div>
          </ActionForm>
        </details>
      </Card>
      {showCost ? (
        <Card title={`Price history (per ${unit})`}>
          {lastH && prev ? (
            <div className="mb-3 flex flex-wrap gap-4 text-sm">
              <span>Latest <b>{money(lastH.base_unit_price, { precise: true })}</b></span>
              <span>Change vs previous <b className={Number(lastH.base_unit_price) > Number(prev.base_unit_price) ? "text-danger" : "text-success"}>
                {money(Number(lastH.base_unit_price) - Number(prev.base_unit_price), { precise: true, sign: true })} ({pct((Number(lastH.base_unit_price) / Number(prev.base_unit_price) - 1) * 100, 2, true)})</b></span>
              <span>Since {dateFmt(first.effective_at)} <b>{pct((Number(lastH.base_unit_price) / Number(first.base_unit_price) - 1) * 100, 2, true)}</b></span>
            </div>
          ) : null}
          <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
            <PriceChart unit={unit} points={hist.map((h) => ({ at: h.effective_at, price: Number(h.base_unit_price), vendor: (h.vendor as unknown as { name: string } | null)?.name }))} />
            <div className="max-h-64 overflow-y-auto">
              <table className="tbl">
                <thead><tr><th>Date</th><th>Vendor</th><th className="num">Price</th><th className="num">Per {unit}</th><th className="num">Δ</th></tr></thead>
                <tbody>
                  {[...hist].reverse().map((h, i, arr) => {
                    const p = arr[i + 1];
                    const d = p ? (Number(h.base_unit_price) / Number(p.base_unit_price) - 1) * 100 : null;
                    return (
                      <tr key={i}><td className="whitespace-nowrap">{dateFmt(h.effective_at)}</td><td>{(h.vendor as unknown as { name: string } | null)?.name ?? "—"}</td>
                        <td className="num">{money(h.unit_price)}/{(h.unit as unknown as { code: string } | null)?.code}</td>
                        <td className="num">{money(h.base_unit_price, { precise: true })}</td>
                        <td className={`num ${d && d > 0 ? "text-danger" : d && d < 0 ? "text-success" : ""}`}>{d === null ? "—" : pct(d, 1, true)}</td></tr>
                    );
                  })}
                  {!hist.length ? <tr><td colSpan={5} className="text-center text-muted">No invoices posted yet</td></tr> : null}
                </tbody>
              </table>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

async function BarcodesTab({ product, options, canEdit }: { product: Record<string, unknown>; options: Record<string, unknown>[]; canEdit: boolean }) {
  const supabase = await createClient();
  const [{ data: codes }, { data: vendors }] = await Promise.all([
    supabase.from("product_barcodes").select("id, barcode, unit:units(code), vendor:vendors(name)").eq("product_id", product.id as string),
    supabase.from("vendors").select("id, name").eq("active", true).order("name"),
  ]);
  return (
    <Card title="UPC / barcodes">
      <table className="tbl mb-4">
        <thead><tr><th>Barcode</th><th>One scan =</th><th>Vendor</th><th /></tr></thead>
        <tbody>
          {(codes ?? []).map((c) => (
            <tr key={c.id}><td className="font-mono">{c.barcode}</td><td>{(c.unit as unknown as { code: string } | null)?.code ?? "—"}</td><td>{(c.vendor as unknown as { name: string } | null)?.name ?? "—"}</td>
              <td className="text-right">{canEdit ? <ActionButton size="sm" variant="ghost" action={removeBarcode.bind(null, c.id)} confirm="Remove this barcode mapping?">Remove</ActionButton> : null}</td></tr>
          ))}
          {!codes?.length ? <tr><td colSpan={4} className="text-center text-muted">No barcodes mapped</td></tr> : null}
        </tbody>
      </table>
      {canEdit ? (
        <ActionForm action={addBarcode.bind(null, product.id as string, product.organization_id as string)} resetOnSuccess>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Barcode" className="w-48"><Input name="barcode" required inputMode="numeric" /></Field>
            <Field label="Unit"><Select name="unit_id" defaultValue=""><option value="">—</option>{options.map((o) => <option key={o.unit_id as string} value={o.unit_id as string}>{o.unit_code as string}</option>)}</Select></Field>
            <Field label="Vendor"><Select name="vendor_id" defaultValue=""><option value="">—</option>{(vendors ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
            <SubmitButton size="sm">Map barcode</SubmitButton>
          </div>
        </ActionForm>
      ) : null}
    </Card>
  );
}

async function AdjustTab({ product, options, loc, unit, onHand }: { product: Record<string, unknown>; options: Record<string, unknown>[]; loc: string; unit: string; onHand: number | null | undefined }) {
  const supabase = await createClient();
  const [{ data: reasons }, { data: storages }] = await Promise.all([
    supabase.from("adjustment_reasons").select("code, name, requires_comment").eq("kind", "adjustment").eq("active", true).order("sort"),
    supabase.from("storage_locations").select("id, name").eq("location_id", loc).eq("active", true).order("sort_order"),
  ]);
  return (
    <Card title="Manual inventory adjustment">
      <p className="mb-3 text-sm text-muted">Current book quantity: <b>{qty(onHand, unit)}</b>. Every adjustment is recorded in the ledger and audit log with the original quantity, the change and the new quantity.</p>
      <ActionForm action={adjustInventory.bind(null, product.id as string)} resetOnSuccess>
        <input type="hidden" name="idempotency_key" value={crypto.randomUUID()} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Direction"><Select name="direction" defaultValue="remove"><option value="remove">Remove (−)</option><option value="add">Add (+)</option></Select></Field>
          <Field label="Quantity"><Input name="qty" inputMode="decimal" required /></Field>
          <Field label="Unit"><Select name="unit_id" defaultValue={String(product.inventory_unit_id)}>{options.map((o) => <option key={o.unit_id as string} value={o.unit_id as string}>{o.unit_code as string}</option>)}</Select></Field>
          <Field label="Reason"><Select name="reason_code" required>{(reasons ?? []).map((r) => <option key={r.code} value={r.code}>{r.name}{r.requires_comment ? " (comment required)" : ""}</option>)}</Select></Field>
          <Field label="Storage"><Select name="storage_location_id" defaultValue=""><option value="">—</option>{(storages ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
          <Field label="Comment" className="sm:col-span-2 lg:col-span-5"><Textarea name="comment" /></Field>
        </div>
        <div className="mt-3 flex justify-end"><SubmitButton>Record adjustment</SubmitButton></div>
      </ActionForm>
    </Card>
  );
}
