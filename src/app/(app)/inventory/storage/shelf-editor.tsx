"use client";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, ArrowUp, ArrowDown, X } from "lucide-react";
import { ActionForm, ActionButton, SubmitButton, useToast } from "@/components/client";
import { Badge, Button, Card, Field, Input, Select, cx, inputBase, inputClass } from "@/components/ui";
import { saveAreaOrder, saveSequence, saveStorageArea, setStorageActive } from "./actions";

type Area = { id: string; name: string; kind: string; sort_order: number; active: boolean };
type Placement = { storage_location_id: string; product_id: string; shelf: string | null; sort_order: number };
type Product = { product_id: string; product_number: string; product_name: string; category_name: string | null; inventory_unit: string };
type Row = { product_id: string; shelf: string };

const KINDS = ["walk_in_cooler", "walk_in_freezer", "reach_in_cooler", "dry_storage", "bar", "line", "prep", "beverage", "chemical", "front", "other"];
const label = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function ShelfEditor({ canEdit, areas, placements, products, initialArea }: { canEdit: boolean; areas: Area[]; placements: Placement[]; products: Product[]; initialArea?: string }) {
  const activeAreas = areas.filter((a) => a.active);
  const [areaId, setAreaId] = useState(initialArea ?? activeAreas[0]?.id ?? "");
  const byProduct = useMemo(() => new Map(products.map((p) => [p.product_id, p])), [products]);
  const initialRows = (id: string) => placements.filter((p) => p.storage_location_id === id).sort((a, b) => a.sort_order - b.sort_order).map((p) => ({ product_id: p.product_id, shelf: p.shelf ?? "" }));
  const [rows, setRows] = useState<Row[]>(initialRows(areaId));
  const [dirty, setDirty] = useState(false);
  const [areaOrder, setAreaOrder] = useState(activeAreas.map((a) => a.id));
  const [pending, start] = useTransition();
  const toast = useToast();
  const router = useRouter();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const unplaced = products.filter((p) => !placements.some((x) => x.product_id === p.product_id));
  const inArea = new Set(rows.map((r) => r.product_id));

  function switchArea(id: string) {
    if (dirty && !confirm("Discard unsaved changes to this area?")) return;
    setAreaId(id); setRows(initialRows(id)); setDirty(false);
  }
  const update = (next: Row[]) => { setRows(next); setDirty(true); };
  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = rows.findIndex((r) => r.product_id === e.active.id);
    const to = rows.findIndex((r) => r.product_id === e.over!.id);
    update(arrayMove(rows, from, to));
  }
  function save() {
    start(async () => {
      const res = await saveSequence(areaId, rows.map((r) => ({ product_id: r.product_id, shelf: r.shelf || null })));
      if (res?.ok) { toast({ tone: "success", text: res.message! }); setDirty(false); router.refresh(); }
      else toast({ tone: "error", text: res?.error ?? "Save failed" });
    });
  }
  function moveArea(i: number, d: -1 | 1) {
    const next = [...areaOrder]; const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    setAreaOrder(next);
    start(async () => { const r = await saveAreaOrder(next); if (!r?.ok) toast({ tone: "error", text: r?.error ?? "Failed" }); else router.refresh(); });
  }
  const area = areas.find((a) => a.id === areaId);
  let lastShelf = "";

  return (
    <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
      <div className="space-y-4">
        <Card title="Walking order" padded={false}>
          <ol className="divide-y divide-border">
            {areaOrder.map((id, i) => {
              const a = areas.find((x) => x.id === id)!;
              const n = placements.filter((p) => p.storage_location_id === id).length;
              return (
                <li key={id} className={cx("flex items-center gap-1 px-2 py-1.5", id === areaId && "bg-brand-soft")}>
                  <button type="button" onClick={() => switchArea(id)} className="flex-1 truncate py-1 text-left text-sm">
                    <span className="mr-2 text-muted tabular-nums">{i + 1}.</span><span className="font-medium">{a.name}</span>
                    <span className="ml-1 text-xs text-muted">({n})</span>
                  </button>
                  {canEdit ? (<>
                    <button type="button" aria-label={`Move ${a.name} up`} disabled={pending || i === 0} onClick={() => moveArea(i, -1)} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                    <button type="button" aria-label={`Move ${a.name} down`} disabled={pending || i === areaOrder.length - 1} onClick={() => moveArea(i, 1)} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                  </>) : null}
                </li>
              );
            })}
          </ol>
        </Card>
        {canEdit ? (
          <Card title="New storage area">
            <ActionForm action={saveStorageArea} resetOnSuccess className="space-y-2">
              <Field label="Name"><Input name="name" required placeholder="Prep Cooler" /></Field>
              <Field label="Type"><Select name="kind" defaultValue="other">{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
              <input type="hidden" name="sort_order" value={areas.length + 1} />
              <SubmitButton size="sm" className="w-full">Add storage area</SubmitButton>
            </ActionForm>
          </Card>
        ) : null}
        {areas.some((a) => !a.active) ? (
          <Card title="Inactive areas">
            {areas.filter((a) => !a.active).map((a) => (
              <div key={a.id} className="flex items-center justify-between py-1 text-sm">{a.name}
                {canEdit ? <ActionButton size="sm" variant="ghost" action={setStorageActive.bind(null, a.id, true)}>Reactivate</ActionButton> : null}
              </div>
            ))}
          </Card>
        ) : null}
        {unplaced.length ? (
          <Card title={`Not in any storage (${unplaced.length})`}>
            <ul className="space-y-1 text-sm">{unplaced.map((p) => <li key={p.product_id}>{p.product_name}</li>)}</ul>
          </Card>
        ) : null}
      </div>

      {area ? (
        <Card
          title={<span className="flex items-center gap-2">{area.name} <Badge>{label(area.kind)}</Badge> {dirty ? <Badge tone="warning">Unsaved</Badge> : null}</span>}
          actions={canEdit ? (
            <>
              <ActionButton size="sm" variant="ghost" action={setStorageActive.bind(null, area.id, false)} confirm={`Deactivate ${area.name}? It will no longer appear on new count sheets.`}>Deactivate</ActionButton>
              <Button size="sm" variant="primary" onClick={save} disabled={!dirty || pending}>{pending ? "Saving…" : "Save order"}</Button>
            </>
          ) : null}
        >
          {canEdit ? (
            <ActionForm action={saveStorageArea} className="mb-4 flex flex-wrap items-end gap-2">
              <input type="hidden" name="id" value={area.id} />
              <Field label="Area name" className="min-w-48 flex-1"><Input name="name" defaultValue={area.name} required /></Field>
              <Field label="Type"><Select name="kind" defaultValue={area.kind}>{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</Select></Field>
              <SubmitButton size="sm" variant="secondary">Rename</SubmitButton>
            </ActionForm>
          ) : null}
          <p className="mb-2 text-xs text-muted">{canEdit ? "Drag the handle (or use the arrows) to match the physical shelf order. Type a shelf name to group items." : "Read only"}</p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={rows.map((r) => r.product_id)} strategy={verticalListSortingStrategy}>
              <ol className="divide-y divide-border rounded-md border border-border">
                {rows.map((r, i) => {
                  const header = r.shelf && r.shelf !== lastShelf ? r.shelf : null;
                  lastShelf = r.shelf || lastShelf;
                  return (
                    <SortableRow key={r.product_id} id={r.product_id} disabled={!canEdit} header={header}>
                      <span className="w-7 text-right text-xs text-muted tabular-nums">{i + 1}.</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{byProduct.get(r.product_id)?.product_name ?? "Inactive product"}</div>
                        <div className="text-xs text-muted">#{byProduct.get(r.product_id)?.product_number} · {byProduct.get(r.product_id)?.category_name ?? "—"} · {byProduct.get(r.product_id)?.inventory_unit}</div>
                      </div>
                      <input aria-label="Shelf" value={r.shelf} disabled={!canEdit} placeholder="Shelf"
                        onChange={(e) => update(rows.map((x) => (x.product_id === r.product_id ? { ...x, shelf: e.target.value } : x)))}
                        className={cx(inputBase, "h-8 w-28")} />
                      {canEdit ? (<>
                        <button type="button" aria-label="Move up" disabled={i === 0} onClick={() => update(arrayMove(rows, i, i - 1))} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                        <button type="button" aria-label="Move down" disabled={i === rows.length - 1} onClick={() => update(arrayMove(rows, i, i + 1))} className="rounded p-1 text-muted hover:bg-surface-2 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                        <button type="button" aria-label="Remove from area" onClick={() => update(rows.filter((x) => x.product_id !== r.product_id))} className="rounded p-1 text-muted hover:bg-danger-soft hover:text-danger"><X className="h-4 w-4" /></button>
                      </>) : null}
                    </SortableRow>
                  );
                })}
                {!rows.length ? <li className="p-6 text-center text-sm text-muted">No items in this area yet.</li> : null}
              </ol>
            </SortableContext>
          </DndContext>
          {canEdit ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <select aria-label="Add product to this area" className={cx(inputClass, "max-w-sm")} value=""
                onChange={(e) => { if (e.target.value) update([...rows, { product_id: e.target.value, shelf: rows[rows.length - 1]?.shelf ?? "" }]); }}>
                <option value="">+ Add a product to {area.name}…</option>
                {products.filter((p) => !inArea.has(p.product_id)).map((p) => <option key={p.product_id} value={p.product_id}>{p.product_name}</option>)}
              </select>
              <span className="text-xs text-muted">A product can live in several areas (e.g. walk-in and line cooler).</span>
            </div>
          ) : null}
        </Card>
      ) : <Card><p className="text-sm text-muted">Create a storage area to start.</p></Card>}
    </div>
  );
}

function SortableRow({ id, disabled, header, children }: { id: string; disabled: boolean; header: string | null; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cx("bg-surface", isDragging && "relative z-10 shadow-lg")}>
      {header ? <div className="bg-surface-2 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{header}</div> : null}
      <div className="flex items-center gap-2 px-2 py-2">
        {!disabled ? (
          <button type="button" aria-label="Drag to reorder" className="cursor-grab touch-none rounded p-1 text-muted hover:bg-surface-2" {...attributes} {...listeners}>
            <GripVertical className="h-4 w-4" />
          </button>
        ) : null}
        {children}
      </div>
    </li>
  );
}
