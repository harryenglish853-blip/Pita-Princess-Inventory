"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { cx } from "@/components/ui";
import { identifyEmployee } from "./actions";

type Person = { id: string; display_name: string; locked: boolean };

export function WhoPicker({ people, next, current }: { people: Person[]; next: string; current: string | null }) {
  const [person, setPerson] = useState<Person | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    if (pin.length !== 4 || !person || pending) return;
    start(async () => {
      const res = await identifyEmployee(person.id, pin);
      if (res?.ok) {
        router.replace(next);
        router.refresh();
      } else {
        setError(res?.error ?? "Incorrect PIN");
        setPin("");
      }
    });
  }, [pin, person, next, router, pending]);

  useEffect(() => {
    if (!person) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) setPin((p) => (p.length < 4 ? p + e.key : p));
      else if (e.key === "Backspace") setPin((p) => p.slice(0, -1));
      else if (e.key === "Escape") { setPerson(null); setPin(""); setError(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [person]);

  if (!person) {
    return (
      <div className="grid grid-cols-2 gap-3" data-testid="who-names">
        {people.map((p) => (
          <button key={p.id} type="button" onClick={() => { setPerson(p); setError(null); setPin(""); }}
            className={cx("flex min-h-20 flex-col items-center justify-center rounded-lg border bg-surface px-3 py-4 text-lg font-semibold hover:border-brand",
              current === p.id ? "border-brand" : "border-border")}>
            {p.display_name}
            {p.locked ? <span className="mt-1 text-xs font-medium text-danger">LOCKED — ask a manager</span> : null}
            {current === p.id ? <span className="mt-1 text-xs font-medium text-brand">Signed in now</span> : null}
          </button>
        ))}
      </div>
    );
  }

  const press = (d: string) => { setError(null); setPin((p) => (p.length < 4 ? p + d : p)); };
  return (
    <div className="mx-auto max-w-xs" data-testid="pin-pad">
      <button type="button" onClick={() => { setPerson(null); setPin(""); setError(null); }} className="mb-3 text-sm text-muted">← Not {person.display_name}?</button>
      <div className="text-center text-lg font-semibold">{person.display_name}</div>
      <div className="my-4 flex justify-center gap-3" aria-label={`${pin.length} of 4 digits entered`} role="status">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx("h-4 w-4 rounded-full border-2 border-brand", i < pin.length && "bg-brand")} />
        ))}
      </div>
      {error ? <p role="alert" className="mb-3 rounded-md bg-danger-soft px-3 py-2 text-center text-sm text-danger">{error}</p> : null}
      {pending ? <p className="mb-3 text-center text-sm text-muted">Checking…</p> : null}
      <div className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" disabled={pending} onClick={() => press(d)} aria-label={d}
            className="h-16 rounded-lg border border-border bg-surface text-2xl font-semibold active:bg-surface-2 disabled:opacity-50">{d}</button>
        ))}
        <span />
        <button type="button" disabled={pending} onClick={() => press("0")} aria-label="0"
          className="h-16 rounded-lg border border-border bg-surface text-2xl font-semibold active:bg-surface-2 disabled:opacity-50">0</button>
        <button type="button" disabled={pending || !pin} onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete"
          className="h-16 rounded-lg border border-border bg-surface text-base active:bg-surface-2 disabled:opacity-50">⌫</button>
      </div>
    </div>
  );
}
