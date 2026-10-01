import { requireContext } from "@/lib/session";
import { ActionForm, SubmitButton } from "@/components/client";
import { Card, Field, Input, Notice, PageHeader } from "@/components/ui";
import { changePassword } from "@/app/(auth)/actions";

export const metadata = { title: "My account" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ reset?: string }> }) {
  const { reset } = await searchParams;
  const ctx = await requireContext();
  return (
    <>
      <PageHeader title="My account" subtitle={`${ctx.user.full_name ?? ""} · ${ctx.user.email}`} />
      {reset ? <div className="mb-4"><Notice tone="info" title="Choose a new password">You followed a reset link. Set your new password below.</Notice></div> : null}
      <Card title="Change password" className="max-w-md">
        <ActionForm action={changePassword} className="space-y-3" resetOnSuccess refresh={false}>
          <Field label="New password"><Input name="password" type="password" autoComplete="new-password" minLength={8} required /></Field>
          <Field label="Type it again"><Input name="confirm" type="password" autoComplete="new-password" minLength={8} required /></Field>
          <SubmitButton>Change password</SubmitButton>
        </ActionForm>
      </Card>
      <p className="mt-4 text-sm text-muted">Roles: {ctx.roles.map((r) => r.name).join(", ") || "none"}</p>
    </>
  );
}
