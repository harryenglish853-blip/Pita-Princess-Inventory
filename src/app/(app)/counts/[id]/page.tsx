import { requirePermission, can } from "@/lib/session";
import { CountScreen } from "./count-screen";

export const metadata = { title: "Count" };

/** Thin server shell: the sheet is loaded on the device (and from its offline copy), so this page works offline once cached. */
export default async function CountPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requirePermission("inventory.count");
  return (
    <CountScreen sessionId={id} userName={ctx.user.full_name ?? ctx.user.email}
      canReview={can(ctx, "inventory.review")} canMapBarcode={can(ctx, "inventory.settings")} />
  );
}
