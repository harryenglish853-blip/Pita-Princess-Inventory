"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, cx, inputBase } from "@/components/ui";
import { useToast } from "@/components/client";
import { receiveTransfer } from "../actions";

export function ReceiveTransfer({ transferId, lines }: { transferId: string; lines: { id: string; name: string; unit: string; sent: number }[] }) {
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(lines.map((l) => [l.id, String(l.sent)])));
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <Card title="Receive and reconcile">
      <table className="tbl mb-3">
        <thead><tr><th>Product</th><th className="num">Sent</th><th className="num">Received</th></tr></thead>
        <tbody>{lines.map((l) => (
          <tr key={l.id}><td>{l.name}</td><td className="num">{l.sent} {l.unit}</td>
            <td className="num"><input aria-label={`Received ${l.name}`} inputMode="decimal" value={qty[l.id]} onChange={(e) => setQty((q) => ({ ...q, [l.id]: e.target.value.replace(/[^0-9.]/g, "") }))}
              className={cx(inputBase, "h-9 w-24 text-right", Number(qty[l.id]) !== l.sent && "border-warning")} /> {l.unit}</td></tr>
        ))}</tbody>
      </table>
      <Button variant="primary" disabled={pending} onClick={() => start(async () => {
        const r = await receiveTransfer(transferId, lines.map((l) => ({ id: l.id, qty_received: qty[l.id] || "0" })));
        if (r?.ok) { toast({ tone: "success", text: r.message! }); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
      })}>{pending ? "Posting…" : "Receive & reconcile"}</Button>
    </Card>
  );
}
