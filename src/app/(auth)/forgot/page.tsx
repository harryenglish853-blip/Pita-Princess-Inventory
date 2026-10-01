import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Field, Input } from "@/components/ui";
import { requestPasswordReset } from "../actions";

export const metadata = { title: "Reset password" };

export default function ForgotPage() {
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <h1 className="mb-1 text-lg font-semibold">Reset your password</h1>
      <p className="mb-4 text-sm text-muted">We&apos;ll email you a link. No email on file? Ask your manager to set a new temporary password.</p>
      <ActionForm action={requestPasswordReset} className="space-y-3" refresh={false} resetOnSuccess>
        <Field label="Email"><Input name="email" type="email" autoComplete="email" required autoFocus /></Field>
        <SubmitButton className="w-full" pendingText="Sending…">Email me a reset link</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm text-muted"><Link href="/login" className="text-brand">Back to sign in</Link></p>
    </div>
  );
}
