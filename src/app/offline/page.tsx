export const metadata = { title: "Offline" };
export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6 text-center">
      <div>
        <h1 className="text-lg font-semibold">You are offline</h1>
        <p className="mt-2 max-w-sm text-sm text-muted">
          Counts you downloaded for offline use still work: open them from the Count tab. Anything you enter is saved on this device and syncs automatically when the connection returns.
        </p>
        <a href="/counts" className="mt-4 inline-block font-medium text-brand">Go to counts</a>
      </div>
    </main>
  );
}
