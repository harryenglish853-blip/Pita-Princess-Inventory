import { redirect } from "next/navigation";
import { requireContext, canOrg } from "@/lib/session";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, PageHeader } from "@/components/ui";
import { VendorFields } from "../vendor-form";
import { saveVendor } from "../actions";

export default async function NewVendorPage() {
  const ctx = await requireContext();
  if (!canOrg(ctx, "vendors.edit")) redirect("/denied?perm=vendors.edit");
  return (
    <>
      <PageHeader title="New vendor" back={{ href: "/vendors", label: "Vendors" }} />
      <ActionForm action={saveVendor.bind(null, null)} redirectTo="/vendors/{id}">
        <Card><VendorFields vendor={null} locations={ctx.locations} /></Card>
        <div className="mt-4 flex justify-end"><SubmitButton>Create vendor</SubmitButton></div>
      </ActionForm>
    </>
  );
}
