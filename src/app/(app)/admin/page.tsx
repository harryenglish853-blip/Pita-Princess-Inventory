import Link from "next/link";
import { requireContext, can, canOrg, orderingEnabled } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/client";
import { setOrderingEnabled } from "./actions";

export const metadata = { title: "Administration" };

export default async function AdminPage() {
  const ctx = await requireContext();
  const links = [
    { href: "/admin/users", label: "Users & permissions", desc: "Add staff, assign roles by location, region or company", show: ctx.locations.some((l) => l.permissions.includes("users.manage")) },
    { href: "/admin/employees", label: "Employees & PINs", desc: "Names and 4-digit PINs for the shared employee login", show: ctx.locations.some((l) => l.permissions.includes("users.manage")) },
    { href: "/admin/locations", label: "Locations & hierarchy", desc: "Restaurants, regions, districts, operating tolerances", show: canOrg(ctx, "locations.manage") || can(ctx, "settings.manage") },
    { href: "/inventory/categories", label: "Categories & units", desc: "Corporate category tree and units of measure", show: true },
    { href: "/inventory/storage", label: "Storage areas", desc: "Storage areas and shelf-to-sheet walking order", show: can(ctx, "inventory.view") },
    { href: "/vendors", label: "Vendors & order guides", desc: "Vendor master and contract pricing", show: can(ctx, "orders.view") },
    { href: "/admin/audit", label: "Audit log", desc: "Who changed what, when, from which device", show: can(ctx, "audit.view") || canOrg(ctx, "audit.view") },
  ].filter((l) => l.show);
  return (
    <>
      <PageHeader title="Administration" />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="rounded-lg border border-border bg-surface p-4 hover:border-brand">
            <div className="font-medium">{l.label}</div>
            <div className="mt-1 text-sm text-muted">{l.desc}</div>
          </Link>
        ))}
      </div>
      {canOrg(ctx, "settings.manage") ? (
        <Card title="How you order" className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="ordering-setting">
            <p className="max-w-2xl text-sm text-muted">
              {orderingEnabled(ctx)
                ? "Orders are placed in this app: suggested orders, purchase orders, and receiving against them."
                : "Orders are placed in each vendor's own app. This app records deliveries from their invoices; stock, costs and price history still update."}
            </p>
            {orderingEnabled(ctx)
              ? <ActionButton action={setOrderingEnabled.bind(null, false)} confirm="Stop placing orders in this app? Order screens are hidden; existing orders and history are kept.">Order in vendor apps instead</ActionButton>
              : <ActionButton action={setOrderingEnabled.bind(null, true)} confirm="Turn on ordering in this app? Suggested orders and purchase orders will appear.">Place orders in this app</ActionButton>}
          </div>
        </Card>
      ) : null}
    </>
  );
}
