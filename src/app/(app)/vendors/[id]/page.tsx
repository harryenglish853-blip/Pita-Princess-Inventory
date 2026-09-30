import { notFound } from "next/navigation";
import Link from "next/link";
import { requirePermission, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, ModalButton, SubmitButton } from "@/components/client";
import { Badge, Card, Field, Input, LinkButton, PageHeader, Select, StatusBadge } from "@/components/ui";
import { money, dateFmt } from "@/lib/format";
import { VendorFields } from "../vendor-form";
import { saveGuideItem, saveVendor } from "../actions";
import { StoreVendorSettings } from "../store-settings";

export default async function VendorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("orders.view");
  const supabase = await createClient();
  const [{ data: vendor }, { data: guide }, { data: products }, { data: options }, { data: orders }, { data: storeOverride }] = await Promise.all([
    supabase.from("vendors").select("*").eq("id", id).single(),
    supabase.from("vendor_products").select("*, product:products(id, name, product_number, inventory_unit_id), unit:units(code)").eq("vendor_id", id).order("guide_sort").order("vendor_item_number"),
    supabase.from("products").select("id, name, product_number").eq("active", true).order("name"),
    supabase.from("product_unit_options").select("product_id, unit_id, unit_code, factor, is_inventory_unit, use_for_purchase, priority"),
    supabase.from("purchase_orders").select("id, po_number, status, expected_delivery_date").eq("vendor_id", id).eq("location_id", ctx.location.id).order("created_at", { ascending: false }).limit(10),
    supabase.from("location_vendors").select("delivery_days, lead_time_days, order_cutoff, account_number, active, notes").eq("vendor_id", id).eq("location_id", ctx.location.id).maybeSingle(),
  ]);
  if (!vendor) notFound();
  const edit = canOrg(ctx, "vendors.edit");
  const showCost = can(ctx, "reports.view_cost");
  const unitsFor = (pid: string) => (options ?? []).filter((o) => o.product_id === pid && (o.use_for_purchase || o.is_inventory_unit || o.priority === 1));
  const factor = (pid: string, uid: string) => Number((options ?? []).find((o) => o.product_id === pid && o.unit_id === uid)?.factor ?? 0);
  const today = new Date().toISOString().slice(0, 10);

  const itemForm = (vp: NonNullable<typeof guide>[number] | null) => (
    <ActionForm action={saveGuideItem.bind(null, id, vp?.id ?? null)} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {vp ? <div className="sm:col-span-2 font-medium">{(vp.product as { name: string }).name}</div> : (
          <Field label="Product" className="sm:col-span-2"><Select name="product_id" required>{(products ?? []).map((p) => <option key={p.id} value={p.id}>{p.name} (#{p.product_number})</option>)}</Select></Field>
        )}
        <Field label="Vendor item #"><Input name="vendor_item_number" required defaultValue={vp?.vendor_item_number ?? ""} /></Field>
        <Field label="Purchase unit" hint={vp ? undefined : "Must have a conversion on the product"}>
          {vp ? (
            <Select name="purchase_unit_id" defaultValue={vp.purchase_unit_id}>{unitsFor(vp.product_id).map((u) => <option key={u.unit_id} value={u.unit_id}>{u.unit_code}</option>)}</Select>
          ) : (
            <Select name="purchase_unit_id" required>{Array.from(new Map((options ?? []).filter((o) => o.priority <= 1).map((o) => [o.unit_id, o.unit_code])).entries()).map(([uid, code]) => <option key={uid} value={uid}>{code}</option>)}</Select>
          )}
        </Field>
        <Field label="Pack size"><Input name="pack_size" defaultValue={vp?.pack_size ?? ""} /></Field>
        <Field label="Current price"><Input name="current_price" inputMode="decimal" required defaultValue={vp?.current_price ?? ""} /></Field>
        <Field label="Contract price"><Input name="contract_price" inputMode="decimal" defaultValue={vp?.contract_price ?? ""} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Contract start"><Input type="date" name="contract_start" defaultValue={vp?.contract_start ?? ""} /></Field>
          <Field label="Contract end"><Input type="date" name="contract_end" defaultValue={vp?.contract_end ?? ""} /></Field>
        </div>
        <Field label="Order multiple"><Input name="order_multiple" inputMode="decimal" defaultValue={vp?.order_multiple ?? "1"} /></Field>
        <Field label="Minimum order qty"><Input name="min_order_qty" inputMode="decimal" defaultValue={vp?.min_order_qty ?? "0"} /></Field>
        <Field label="Guide position"><Input name="guide_sort" inputMode="numeric" defaultValue={vp?.guide_sort ?? "0"} /></Field>
        <div className="flex items-center gap-4 text-sm">
          <label className="inline-flex items-center gap-2"><input type="checkbox" name="is_preferred" defaultChecked={vp?.is_preferred ?? false} /> Preferred</label>
          <label className="inline-flex items-center gap-2"><input type="checkbox" name="active" defaultChecked={vp?.active ?? true} /> Active</label>
        </div>
      </div>
      <div className="flex justify-end"><SubmitButton size="sm">Save item</SubmitButton></div>
    </ActionForm>
  );

  return (
    <>
      <PageHeader title={<span className="flex items-center gap-2">{vendor.name}{!vendor.active ? <Badge tone="danger">Inactive</Badge> : null}</span>}
        back={{ href: "/vendors", label: "Vendors" }}
        subtitle={`${vendor.vendor_number ?? ""} · Account ${vendor.account_number ?? "—"} · ${vendor.sales_rep ?? ""} ${vendor.phone ?? ""}`}
        actions={can(ctx, "orders.create") ? <LinkButton variant="primary" href={`/purchasing/new?vendor=${id}`}>Create order</LinkButton> : null} />
      <div className="grid gap-4 xl:grid-cols-[1fr_22rem]">
        <Card title={`Order guide (${guide?.length ?? 0} items)`} padded={false}
          actions={edit ? <ModalButton label="Add item" title="Add order guide item" size="sm" variant="primary">{itemForm(null)}</ModalButton> : null}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Product</th><th>Vendor SKU</th><th>Pack</th><th>Unit</th>{showCost ? <><th className="num">Price</th><th className="num">Contract</th><th className="num">Per inv. unit</th></> : null}<th /></tr></thead>
              <tbody>
                {(guide ?? []).map((vp) => {
                  const p = vp.product as { id: string; name: string; product_number: string };
                  const contractActive = vp.contract_price && (!vp.contract_start || vp.contract_start <= today) && (!vp.contract_end || vp.contract_end >= today);
                  const eff = contractActive ? Number(vp.contract_price) : Number(vp.current_price);
                  const f = factor(vp.product_id, vp.purchase_unit_id);
                  return (
                    <tr key={vp.id} className={!vp.active ? "opacity-50" : ""}>
                      <td><Link href={`/inventory/items/${p.id}?tab=vendors`} className="font-medium text-brand">{p.name}</Link> {vp.is_preferred ? <Badge tone="brand">Preferred</Badge> : null}</td>
                      <td className="font-mono text-xs">{vp.vendor_item_number}</td><td>{vp.pack_size ?? "—"}</td><td>{(vp.unit as { code: string }).code}</td>
                      {showCost ? <>
                        <td className="num">{money(vp.current_price)}</td>
                        <td className="num">{vp.contract_price ? <span className={contractActive ? "font-medium" : "text-muted line-through"}>{money(vp.contract_price)}</span> : "—"}{vp.contract_end ? <div className="text-[11px] text-muted">to {dateFmt(vp.contract_end)}</div> : null}</td>
                        <td className="num">{f ? money(eff / f, { precise: true }) : "—"}</td>
                      </> : null}
                      <td className="text-right">{edit ? <ModalButton label="Edit" title={`Edit ${p.name}`} size="sm" variant="ghost">{itemForm(vp)}</ModalButton> : null}</td>
                    </tr>
                  );
                })}
                {!guide?.length ? <tr><td colSpan={8} className="py-8 text-center text-muted">No items on this order guide yet</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="space-y-4">
          <StoreVendorSettings vendorId={id} storeLabel={`#${ctx.location.code} ${ctx.location.name}`} company={vendor}
            override={storeOverride} editable={can(ctx, "products.local_edit")} />
          <Card title="Recent orders">
            <ul className="space-y-1 text-sm">
              {(orders ?? []).map((o) => (
                <li key={o.id} className="flex items-center justify-between gap-2"><Link className="text-brand" href={`/purchasing/${o.id}`}>{o.po_number}</Link><span className="text-muted">{dateFmt(o.expected_delivery_date)}</span><StatusBadge status={o.status} /></li>
              ))}
              {!orders?.length ? <li className="text-muted">No orders yet</li> : null}
            </ul>
          </Card>
        </div>
      </div>
      <Card title="Vendor details" className="mt-4">
        <ActionForm action={saveVendor.bind(null, id)}>
          <VendorFields vendor={vendor} disabled={!edit} />
          {edit ? <div className="mt-3 flex justify-end"><SubmitButton>Save vendor</SubmitButton></div> : null}
        </ActionForm>
      </Card>
    </>
  );
}
