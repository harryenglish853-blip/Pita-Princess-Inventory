import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/client";
import { Field, Input, Select } from "@/components/ui";
import { getSession } from "@/lib/session";
import { createOrganization } from "./actions";

export const metadata = { title: "Set up your restaurant" };

const ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "Europe/London", "UTC"];

export default async function OnboardingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.locations.length > 0) redirect("/");
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-lg border border-border bg-surface p-6">
        <h1 className="text-lg font-semibold">Set up your restaurant</h1>
        <p className="mb-4 mt-1 text-sm text-muted">
          You will be the System Owner. If you were expecting to join an existing restaurant, ask your manager to add {session.user.email}.
        </p>
        <ActionForm action={createOrganization} redirectTo="/" className="space-y-3">
          <Field label="Company / group name"><Input name="org_name" required placeholder="Princess Pita Restaurant Group" /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Store #" className="col-span-1"><Input name="location_code" required placeholder="101" /></Field>
            <Field label="Restaurant name" className="col-span-2"><Input name="location_name" required placeholder="Downtown" /></Field>
          </div>
          <Field label="Time zone">
            <Select name="timezone" defaultValue="America/New_York">{ZONES.map((z) => <option key={z}>{z}</option>)}</Select>
          </Field>
          <SubmitButton className="w-full">Create restaurant</SubmitButton>
        </ActionForm>
      </div>
    </main>
  );
}
