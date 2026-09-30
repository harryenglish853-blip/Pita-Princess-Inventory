import Link from "next/link";
import { requireContext, can, canOrg } from "@/lib/session";
import { PageHeader } from "@/components/ui";

export const metadata = { title: "Administration" };

export default async function AdminPage() {
  const ctx = await requireContext();
  const links = [
    { href: "/admin/users", label: "Users & permissions", desc: "Add staff, assign roles by location, region or company", show: ctx.locations.some((l) => l.permissions.includes("users.manage")) },
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
    </>
  );
}
