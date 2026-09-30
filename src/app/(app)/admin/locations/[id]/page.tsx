import { notFound, redirect } from "next/navigation";
import { requireContext, can, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader } from "@/components/ui";
import { LocationFields } from "../location-fields";
import { saveLocation } from "../../actions";

export default async function LocationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireContext();
  const manage = canOrg(ctx, "locations.manage");
  if (!manage && !can(ctx, "settings.manage", id)) redirect("/denied?perm=settings.manage");
  const supabase = await createClient();
  const [{ data: loc }, { data: regions }, { data: districts }] = await Promise.all([
    supabase.from("locations").select("*").eq("id", id).single(),
    supabase.from("regions").select("id, name").order("name"),
    supabase.from("districts").select("id, name").order("name"),
  ]);
  if (!loc) notFound();
  return (
    <>
      <PageHeader title={`#${loc.code} ${loc.name}`} back={{ href: "/admin/locations", label: "Locations" }} />
      <Card>
        <ActionForm action={saveLocation.bind(null, id)}>
          <LocationFields loc={loc} regions={regions ?? []} districts={districts ?? []} hierarchyEditable={manage} />
          <div className="mt-4 flex justify-end"><SubmitButton>Save location</SubmitButton></div>
        </ActionForm>
      </Card>
    </>
  );
}
