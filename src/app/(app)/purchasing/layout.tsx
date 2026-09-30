import { redirect } from "next/navigation";
import { orderingEnabled, requireContext } from "@/lib/session";

/** Ordering screens exist only when the organization places orders in this app. */
export default async function PurchasingLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireContext();
  if (!orderingEnabled(ctx)) redirect("/receiving");
  return children;
}
