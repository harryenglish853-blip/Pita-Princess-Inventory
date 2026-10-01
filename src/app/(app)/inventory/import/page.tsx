import { redirect } from "next/navigation";
import { requirePermission, canOrg } from "@/lib/session";
import { PageHeader } from "@/components/ui";
import { ImportProducts } from "./import-products";

export const metadata = { title: "Import products" };

export default async function ImportPage() {
  const ctx = await requirePermission("inventory.settings");
  if (!canOrg(ctx, "products.edit")) redirect("/denied?perm=products.edit");
  return (
    <>
      <PageHeader title="Import products" back={{ href: "/inventory", label: "Inventory" }}
        subtitle={`Add or update many items at once from a spreadsheet. Storage areas are set up for #${ctx.location.code} ${ctx.location.name}.`} />
      <ImportProducts />
    </>
  );
}
