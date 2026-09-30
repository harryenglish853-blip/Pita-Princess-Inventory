"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, useToast } from "@/components/client";
import { Button, Select } from "@/components/ui";
import { newReceipt } from "./actions";

/** Records a delivery that was ordered outside this app (vendor app, phone, rep). */
export function NewReceiptButton({ vendors, label = "Log a delivery", primary = true, openFor }: {
  vendors: { id: string; name: string }[]; label?: string; primary?: boolean; openFor?: string;
}) {
  const initial = vendors.some((v) => v.id === openFor) ? openFor! : vendors[0]?.id ?? "";
  const [open, setOpen] = useState(!!openFor && vendors.some((v) => v.id === openFor));
  const [vendor, setVendor] = useState(initial);
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <Button variant={primary ? "primary" : "secondary"} onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Log a delivery">
        <p className="mb-3 text-sm text-muted">Which vendor delivered? Next you&apos;ll scan the invoice or tick the items that arrived.</p>
        <Select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor">{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" disabled={pending || !vendor} onClick={() => start(async () => {
            const r = await newReceipt(vendor);
            if (r?.ok) router.push(`/receiving/${r.data!.id}`); else toast({ tone: "error", text: r?.error ?? "Failed" });
          })}>{pending ? "Starting…" : "Start"}</Button>
        </div>
      </Modal>
    </>
  );
}
