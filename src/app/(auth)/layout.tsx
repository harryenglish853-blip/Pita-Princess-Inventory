export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-brand text-lg font-bold text-white">S</div>
          <div>
            <div className="font-semibold leading-tight">Stockline</div>
            <div className="text-xs text-muted">Restaurant inventory & food cost</div>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
