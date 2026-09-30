"use client";
import { useState } from "react";
import { ActionForm, Modal, SubmitButton } from "@/components/client";
import { Button, Field, Input, Select } from "@/components/ui";
import { createCount } from "./actions";

const TYPES = [
  ["daily", "Daily count", "Items flagged for daily counting"],
  ["weekly", "Weekly count", "Items on the weekly count list"],
  ["month_end", "Month-end count", "Every active item (period close)"],
  ["full", "Full inventory", "Every active item"],
  ["cycle", "Cycle count", "Pick storage areas or categories"],
  ["storage", "Location count", "Selected storage areas only"],
  ["category", "Category count", "Selected categories only"],
  ["custom", "Custom count", "Any combination of filters"],
] as const;

function localNow() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function StartCount({ storages, categories }: { storages: { id: string; name: string }[]; categories: { id: string; name: string; level: number }[] }) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("weekly");
  const [key] = useState(() => (typeof crypto !== "undefined" ? crypto.randomUUID() : ""));
  const showFilters = ["cycle", "storage", "category", "custom"].includes(type);
  return (
    <>
      <Button variant="primary" size="lg" onClick={() => setOpen(true)}>Start count</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Start a count">
        <ActionForm action={createCount} redirectTo={(d) => `/counts/${(d as { id: string }).id}`} className="space-y-4">
          <input type="hidden" name="client_key" value={key} />
          <div className="grid grid-cols-2 gap-2">
            {TYPES.map(([v, l, d]) => (
              <label key={v} className={`cursor-pointer rounded-md border p-2 text-sm ${type === v ? "border-brand bg-brand-soft" : "border-border"}`}>
                <input type="radio" name="count_type" value={v} checked={type === v} onChange={() => setType(v)} className="sr-only" />
                <div className="font-medium">{l}</div><div className="text-xs text-muted">{d}</div>
              </label>
            ))}
          </div>
          {showFilters ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-muted">Storage areas</legend>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {storages.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><input type="checkbox" name="storage_ids" value={s.id} /> {s.name}</label>)}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-1 text-xs font-medium text-muted">Categories</legend>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {categories.map((c) => <label key={c.id} className="flex items-center gap-2 text-sm" style={{ paddingLeft: (c.level - 1) * 12 }}><input type="checkbox" name="category_ids" value={c.id} /> {c.name}</label>)}
                </div>
              </fieldset>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name (optional)"><Input name="name" placeholder="Sunday night count" /></Field>
            <Field label="Count as of" hint="Book inventory is compared at this moment"><Input type="datetime-local" name="count_at" defaultValue={localNow()} /></Field>
          </div>
          <div className="flex justify-end"><SubmitButton size="lg" pendingText="Building count sheet…">Start count</SubmitButton></div>
        </ActionForm>
      </Modal>
    </>
  );
}
