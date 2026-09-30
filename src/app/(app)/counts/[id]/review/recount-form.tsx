"use client";
import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { useToast } from "@/components/client";
import { requestRecount } from "../../actions";

/** Wraps the review table so managers can tick lines and send them back for recount. */
export function RecountForm({ sessionId, enabled, children }: { sessionId: string; enabled: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  function send() {
    const ids = new FormData(ref.current!).getAll("product_ids").map(String);
    if (!ids.length) { toast({ tone: "info", text: "Tick the items to recount" }); return; }
    start(async () => {
      const r = await requestRecount(sessionId, ids);
      if (r?.ok) { toast({ tone: "success", text: `Recount requested for ${ids.length} item(s)` }); router.refresh(); }
      else toast({ tone: "error", text: r?.error ?? "Failed" });
    });
  }
  return (
    <form ref={ref} onSubmit={(e) => e.preventDefault()}>
      {enabled ? (
        <div className="mb-2 flex justify-end">
          <Button size="sm" onClick={send} disabled={pending}>{pending ? "Sending…" : "Request recount for selected"}</Button>
        </div>
      ) : null}
      {children}
    </form>
  );
}
