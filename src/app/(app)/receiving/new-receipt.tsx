"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Modal, useToast } from "@/components/client";
import { Button, Select } from "@/components/ui";
import { newReceipt } from "./actions";

export function NewReceiptButton({ vendors }: { vendors: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState(vendors[0]?.id ?? "");
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <>
      <Button onClick={() => setOpen(true)}>Receive without PO</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Receive a delivery without a purchase order">
        <p className="mb-3 text-sm text-muted">Use this for unplanned deliveries. Every line is added manually and flagged as unordered.</p>
        <Select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor">{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>
        <div className="mt-4 flex justify-end">
          <Button variant="primary" disabled={pending || !vendor} onClick={() => start(async () => {
            const r = await newReceipt(vendor);
            if (r?.ok) router.push(`/receiving/${r.data!.id}`); else toast({ tone: "error", text: r?.error ?? "Failed" });
          })}>{pending ? "Starting…" : "Start receiving"}</Button>
        </div>
      </Modal>
    </>
  );
}
