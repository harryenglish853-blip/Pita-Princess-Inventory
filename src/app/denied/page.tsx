import Link from "next/link";
export default async function Denied({ searchParams }: { searchParams: Promise<{ perm?: string }> }) {
  const { perm } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center p-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">You don&apos;t have access to this page</h1>
        <p className="mt-2 text-sm text-muted">Permission required: <code>{perm}</code>. Ask your manager if you need it.</p>
        <Link href="/" className="mt-4 inline-block font-medium text-brand">Back to home</Link>
      </div>
    </main>
  );
}
