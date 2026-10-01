import Link from "next/link";
import { requireContext, visibleNav } from "@/lib/session";
import { NAV } from "@/components/shell/nav-items";
import { Sidebar, MobileNav } from "@/components/shell/sidebar";
import { LocationSwitcher } from "@/components/shell/location-switcher";
import { SyncIndicator } from "@/components/offline/sync-indicator";
import { Icon } from "@/components/shell/icons";
import { SignOutButton } from "@/components/shell/sign-out";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  const items = visibleNav(ctx, NAV);
  const org = ctx.organizations.find((o) => o.id === ctx.organizationId);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="no-print sticky top-0 hidden h-dvh overflow-y-auto border-r border-border bg-surface lg:block">
        <Link href="/" className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="grid h-8 w-8 place-items-center rounded-md bg-brand font-bold text-white">S</div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight">{org?.name ?? "Stockline"}</div>
            <div className="text-[11px] text-muted">Stockline inventory</div>
          </div>
        </Link>
        <Sidebar items={items} />
      </aside>
      <div className="min-w-0">
        <header className="no-print sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-4">
          <LocationSwitcher locations={ctx.locations} current={ctx.location.id} />
          <Link href="/search" aria-label="Search" className="ml-auto grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-surface-2 sm:hidden"><Icon name="search" className="h-5 w-5" /></Link>
          <form action="/search" className="ml-auto hidden min-w-0 max-w-md flex-1 items-center justify-end sm:flex">
            <label className="relative w-full max-w-xs">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"><Icon name="search" /></span>
              <input name="q" type="search" placeholder="Search products, invoices, lots…" aria-label="Global search"
                className="h-9 w-full rounded-md border border-border bg-surface-2 pl-8 pr-2 text-sm focus:border-brand focus:bg-surface focus:outline-none" />
            </label>
          </form>
          <span className="hidden sm:inline-flex"><SyncIndicator /></span>
          <details className="relative">
            <summary className="grid h-9 w-9 cursor-pointer list-none place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand" aria-label="Account">
              {(ctx.user.full_name ?? ctx.user.email).slice(0, 1).toUpperCase()}
            </summary>
            <div className="absolute right-0 z-30 mt-2 w-60 rounded-md border border-border bg-surface p-2 shadow-lg">
              <div className="px-2 py-1.5 text-sm">
                <div className="font-medium">{ctx.user.full_name}</div>
                <div className="truncate text-xs text-muted">{ctx.user.email}</div>
                <div className="mt-1 text-xs text-muted">{ctx.roles.map((r) => r.name).join(", ")}</div>
              </div>
              <Link href="/account" className="block rounded px-2 py-1.5 text-sm hover:bg-surface-2">My account</Link>
              <SignOutButton />
            </div>
          </details>
        </header>
        <main className="mx-auto max-w-[1400px] px-3 pb-28 pt-4 sm:px-5 lg:pb-10">{children}</main>
      </div>
      <MobileNav items={items} ordering={items.some((i) => i.href === "/purchasing")} />
    </div>
  );
}
