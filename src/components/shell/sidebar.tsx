"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/components/ui";
import { Icon } from "./icons";
import type { NavItem } from "./nav-items";

export function isActive(pathname: string, href: string, all: { href: string }[]) {
  if (href === "/") return pathname === "/";
  if (!(pathname === href || pathname.startsWith(href + "/"))) return false;
  // prefer the most specific match (e.g. /inventory/storage over /inventory)
  return !all.some((o) => o.href !== href && o.href.startsWith(href) && (pathname === o.href || pathname.startsWith(o.href + "/")));
}

export function Sidebar({ items }: { items: NavItem[] }) {
  const pathname = usePathname();
  const sections = Array.from(new Set(items.map((i) => i.section)));
  return (
    <nav className="flex flex-col gap-4 px-3 py-4" aria-label="Main">
      {sections.map((s) => (
        <div key={s}>
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{s}</div>
          {items.filter((i) => i.section === s).map((i) => {
            const active = isActive(pathname, i.href, items);
            return (
              <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
                className={cx("flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm", active ? "bg-brand-soft font-medium text-brand" : "text-text hover:bg-surface-2")}>
                <Icon name={i.icon} />
                {i.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

type Tab = { href: string; label: string; icon: string; primary?: boolean };

export function MobileNav({ items, mode }: { items: NavItem[]; mode: "employee" | "management" }) {
  const pathname = usePathname();
  const has = (href: string) => items.some((i) => i.href === href);
  const tabs: Tab[] = mode === "employee" ? [
    { href: "/", label: "Home", icon: "home" },
    { href: "/receiving", label: "Receive", icon: "truck", primary: true },
    { href: "/waste", label: "Waste", icon: "trash" },
    { href: "/tasks", label: "Tasks", icon: "bell" },
  ] : ([
    { href: "/", label: "Home", icon: "home" },
    { href: "/inventory", label: "Inventory", icon: "boxes" },
    { href: "/counts", label: "Count", icon: "clipboard", primary: true },
    has("/ordering") ? { href: "/ordering", label: "Orders", icon: "cart" } : { href: "/receiving", label: "Receive", icon: "truck" },
    { href: "/more", label: "More", icon: "menu" },
  ] as Tab[]).filter((t) => t.href === "/" || t.href === "/more" || has(t.href));
  return (
    <nav aria-label="Primary" className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] lg:hidden">
      <div className="grid" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((t) => {
          const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link key={t.href} href={t.href} className={cx("flex flex-col items-center justify-center gap-0.5 py-2 text-[11px]", active ? "text-brand" : "text-muted")}>
              {t.primary ? (
                <span className={cx("-mt-5 grid h-12 w-12 place-items-center rounded-full border-4 border-bg shadow", active ? "bg-brand-strong" : "bg-brand", "text-white")}>
                  <Icon name={t.icon} className="h-5 w-5" />
                </span>
              ) : (
                <Icon name={t.icon} className="h-5 w-5" />
              )}
              <span className={cx(t.primary && "font-semibold")}>{t.label}</span>
            </Link>
          );
        })}
      </div>
      <span className="sr-only">{items.length} sections available under More</span>
    </nav>
  );
}
