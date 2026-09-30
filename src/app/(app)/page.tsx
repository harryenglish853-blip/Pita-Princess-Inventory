import { requireContext } from "@/lib/session";
import { PageHeader } from "@/components/ui";

export default async function Dashboard() {
  const ctx = await requireContext();
  return <PageHeader title="Overview" subtitle={`#${ctx.location.code} ${ctx.location.name}`} />;
}
