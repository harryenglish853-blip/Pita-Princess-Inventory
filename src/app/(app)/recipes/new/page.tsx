import { redirect } from "next/navigation";
import { requireContext, canOrg } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader } from "@/components/ui";
import { RecipeFields } from "../recipe-fields";
import { saveRecipe } from "../actions";

export default async function NewRecipe() {
  const ctx = await requireContext();
  if (!canOrg(ctx, "recipes.edit")) redirect("/denied?perm=recipes.edit");
  const supabase = await createClient();
  const [{ data: units }, { data: products }] = await Promise.all([
    supabase.from("units").select("id, code, name").eq("active", true).order("sort"),
    supabase.from("products").select("id, name").eq("is_prepped", true).eq("active", true).order("name"),
  ]);
  return (
    <>
      <PageHeader title="New recipe" back={{ href: "/recipes", label: "Recipes" }} />
      <ActionForm action={saveRecipe.bind(null, null)} redirectTo="/recipes/{id}">
        <Card><RecipeFields recipe={{ yield_unit_id: units?.find((u) => u.code === "EA")?.id }} units={units ?? []} products={products ?? []} /></Card>
        <div className="mt-4 flex justify-end"><SubmitButton>Create recipe &amp; add ingredients</SubmitButton></div>
      </ActionForm>
    </>
  );
}
