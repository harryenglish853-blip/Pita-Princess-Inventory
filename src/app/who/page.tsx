import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession, LOCATION_COOKIE } from "@/lib/session";
import { createClient } from "@/lib/supabase/server";
import { WhoPicker } from "./who-picker";

export const metadata = { title: "Who are you?" };

export default async function WhoPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.locations.length === 0) redirect("/onboarding");
  const jar = await cookies();
  const wanted = jar.get(LOCATION_COOKIE)?.value ?? session.user.default_location_id;
  const location = session.locations.find((l) => l.id === wanted) ?? session.locations[0];
  const shared = session.organizations.find((o) => o.id === location.organization_id)?.shared_login === true;
  if (!shared) redirect("/");
  const supabase = await createClient();
  const { data: people, error } = await supabase.rpc("list_pin_employees", { p_location: location.id });
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 py-8 sm:items-center">
      <div className="w-full max-w-lg">
        <div className="mb-5 text-center">
          <div className="text-xs font-medium uppercase tracking-wider text-muted">#{location.code} {location.name}</div>
          <h1 className="mt-1 text-2xl font-semibold">Who are you?</h1>
          <p className="mt-1 text-sm text-muted">Tap your name, then enter your 4-digit PIN. Everything you do is recorded under your name.</p>
        </div>
        {error ? <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error.message}</p> : null}
        {!error && !people?.length ? (
          <div className="rounded-lg border border-dashed border-border-strong bg-surface p-6 text-center text-sm">
            <p className="font-medium">No employees are set up for this store yet.</p>
            <p className="mt-1 text-muted">A manager adds names and PINs under Administration → Employees &amp; PINs.</p>
          </div>
        ) : (
          <WhoPicker people={(people ?? []) as { id: string; display_name: string; locked: boolean }[]} next={safeNext} current={session.employee?.id ?? null} />
        )}
        <form action="/auth/signout" method="post" className="mt-6 text-center">
          <button className="text-sm text-muted underline">Sign out of this device</button>
        </form>
        {session.employee ? <p className="mt-2 text-center text-sm"><Link href={safeNext} className="text-brand">Continue as {session.employee.display_name}</Link></p> : null}
      </div>
    </main>
  );
}
