import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/client";
import { Field, Input } from "@/components/ui";
import { signIn } from "../actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <div className="rounded-lg border border-border bg-surface p-6">
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      {error === "link" ? <p role="alert" className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">That link has expired or was already used. Sign in, or ask for a new link.</p> : null}
      <ActionForm action={signIn} className="space-y-3" refresh={false}>
        <input type="hidden" name="next" value={next ?? "/"} />
        <Field label="Email"><Input name="email" type="email" autoComplete="email" required autoFocus /></Field>
        <Field label="Password"><Input name="password" type="password" autoComplete="current-password" required /></Field>
        <SubmitButton className="w-full" pendingText="Signing in…">Sign in</SubmitButton>
      </ActionForm>
      <p className="mt-3 text-center text-sm"><Link href="/forgot" className="text-brand">Forgot password?</Link></p>
      <p className="mt-4 text-center text-sm text-muted">
        New restaurant? <Link href="/signup" className="font-medium text-brand">Create an account</Link>
      </p>
    </div>
  );
}
