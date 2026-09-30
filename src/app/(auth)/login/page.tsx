import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Field, Input } from "@/components/ui";
import { signIn } from "../actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      <ActionForm action={signIn} className="space-y-3" refresh={false}>
        <input type="hidden" name="next" value={next ?? "/"} />
        <Field label="Email"><Input name="email" type="email" autoComplete="email" required autoFocus /></Field>
        <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required /></Field>
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm text-muted">
        New restaurant? <Link href="/signup" className="font-medium text-brand">Create an account</Link>
      </p>
    </div>
  );
}
