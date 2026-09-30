"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, cx, inputBase } from "@/components/ui";
import { useToast } from "@/components/client";
import { mapPosItem } from "../actions";

export function MapItem({ posItemId, itemName, recipes }: { posItemId: string | null; itemName: string; recipes: { id: string; name: string }[] }) {
  const [recipe, setRecipe] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const toast = useToast();
  return (
    <div className="flex gap-1">
      <select aria-label={`Recipe for ${itemName}`} value={recipe} onChange={(e) => setRecipe(e.target.value)} className={cx(inputBase, "h-8 max-w-44 text-xs")}>
        <option value="">Map to recipe…</option>{recipes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
      </select>
      <Button size="sm" disabled={!recipe || pending} onClick={() => start(async () => {
        const r = await mapPosItem(posItemId, itemName, recipe);
        if (r?.ok) { toast({ tone: "success", text: r.message! }); router.refresh(); } else toast({ tone: "error", text: r?.error ?? "Failed" });
      })}>Map</Button>
    </div>
  );
}
