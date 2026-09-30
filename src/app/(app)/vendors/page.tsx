import { requirePermission, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { DataTable } from "@/components/data-table";
import { LinkButton, PageHeader } from "@/components/ui";
import { dayNames } from "./vendor-form";

export const metadata = { title: "Vendors" };

export default async function VendorsPage() {
  const ctx = await requirePermission("orders.view");
  const supabase = await createClient();
  const [{ data: vendors }, { data: items }] = await Promise.all([
    supabase.from("vendors").select("*").order("name"),
    supabase.from("vendor_products").select("vendor_id").eq("active", true),
  ]);
  const rows = (vendors ?? []).map((v) => ({
    ...v, delivery: dayNames(v.delivery_days), items: (items ?? []).filter((i) => i.vendor_id === v.id).length,
    status: v.active ? "Active" : "Inactive", cutoff: v.order_cutoff?.slice(0, 5) ?? "—",
  }));
  return (
    <>
      <PageHeader title="Vendors" subtitle="Vendor master, delivery schedules and order guides"
        actions={canOrg(ctx, "vendors.edit") ? <LinkButton href="/vendors/new" variant="primary">New vendor</LinkButton> : null} />
      <DataTable id="vendors" rows={rows} columns={[
        { key: "name", label: "Vendor", href: "/vendors/{id}" },
        { key: "account_number", label: "Account #" },
        { key: "sales_rep", label: "Sales rep" },
        { key: "phone", label: "Phone" },
        { key: "delivery", label: "Delivers" },
        { key: "lead_time_days", label: "Lead days", format: "number" },
        { key: "cutoff", label: "Cutoff" },
        { key: "minimum_order", label: "Minimum", format: "money" },
        { key: "items", label: "Guide items", format: "number" },
        { key: "status", label: "Status", filterable: true },
      ]} />
    </>
  );
}
