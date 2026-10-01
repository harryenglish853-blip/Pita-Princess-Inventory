import { Badge } from "@/components/ui";

const LABELS: Record<string, string> = {
  draft: "DRAFT", submitted: "SUBMITTED", accepted: "ACCEPTED", preparing: "PREPARING", ready: "READY",
  in_transit: "IN TRANSIT", received: "RECEIVED", cancelled: "CANCELLED",
};
export const COMMISSARY_STEPS = ["submitted", "accepted", "preparing", "ready", "in_transit", "received"] as const;
export const statusLabel = (s: string) => LABELS[s] ?? s.toUpperCase();

export function CommissaryStatus({ status }: { status: string }) {
  const tone = status === "received" ? "success" : status === "cancelled" ? "neutral" : status === "in_transit" ? "warning" : status === "draft" ? "neutral" : "info";
  return <Badge tone={tone}>{statusLabel(status)}</Badge>;
}
