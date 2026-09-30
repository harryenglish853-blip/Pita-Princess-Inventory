import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Field, Input } from "@/components/ui";
import { signUp } from "../actions";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <h1 className="mb-1 text-lg font-semibold">Create your account</h1>
      <p className="mb-4 text-sm text-muted">Staff members are added by their manager — they do not need to sign up.</p>
      <ActionForm action={signUp} className="space-y-3" refresh={false}>
        <Field label="Your name"><Input name="full_name" required autoComplete="name" /></Field>
        <Field label="Email"><Input name="email" type="email" required autoComplete="email" /></Field>
        <Field label="Password" hint="At least 8 characters"><Input name="password" type="password" required minLength={8} autoComplete="new-password" /></Field>
        <SubmitButton className="w-full">Create account</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm text-muted">
        Already have an account? <Link href="/login" className="font-medium text-brand">Sign in</Link>
      </p>
    </div>
  );
}
