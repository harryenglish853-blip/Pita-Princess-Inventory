import { requirePermission, can } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import { ShelfEditor } from "./shelf-editor";

export const metadata = { title: "Storage & shelf order" };

export default async function StoragePage({ searchParams }: { searchParams: Promise<{ area?: string }> }) {
  const ctx = await requirePermission("inventory.view");
  const { area } = await searchParams;
  const supabase = await createClient();
  const [{ data: areas }, { data: placements }, { data: products }] = await Promise.all([
    supabase.from("storage_locations").select("id, name, kind, sort_order, active").eq("location_id", ctx.location.id).order("sort_order").order("name"),
    supabase.from("product_storage_locations").select("storage_location_id, product_id, shelf, sort_order").eq("location_id", ctx.location.id).eq("active", true).order("sort_order"),
    supabase.from("current_inventory").select("product_id, product_number, product_name, category_name, inventory_unit").eq("location_id", ctx.location.id).eq("active", true).order("product_name"),
  ]);
  return (
    <>
      <PageHeader title="Storage & shelf-to-sheet" back={{ href: "/inventory", label: "Inventory" }}
        subtitle="Arrange items in the exact order people walk past them. Count sheets follow this order." />
      <ShelfEditor
        canEdit={can(ctx, "inventory.settings")}
        areas={areas ?? []}
        placements={placements ?? []}
        products={products ?? []}
        initialArea={area}
      />
    </>
  );
}
