import Link from "next/link";
import { requireContext, visibleNav } from "@/lib/session";
import { NAV } from "@/components/shell/nav-items";
import { Icon } from "@/components/shell/icons";
import { PageHeader } from "@/components/ui";
import { SignOutButton } from "@/components/shell/sign-out";

export const metadata = { title: "More" };

export default async function MorePage() {
  const ctx = await requireContext();
  const items = visibleNav(ctx, NAV);
  return (
    <>
      <PageHeader title="More" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 text-sm font-medium hover:border-brand">
            <Icon name={i.icon} className="h-5 w-5 text-brand" /> {i.label}
          </Link>
        ))}
        <SignOutButton className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 text-left text-sm font-medium hover:border-danger" />
      </div>
    </>
  );
}
