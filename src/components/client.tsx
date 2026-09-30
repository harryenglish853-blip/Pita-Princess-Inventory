"use client";

import { useRouter } from "next/navigation";
import { createContext, useActionState, useCallback, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action-types";
import { Button, cx } from "./ui";

// ---------------------------------------------------------------- Toasts
type Toast = { id: number; tone: "success" | "error" | "info"; text: string };
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x, { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), t.tone === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cx(
              "pointer-events-auto max-w-md rounded-md px-4 py-2.5 text-sm font-medium shadow-lg",
              t.tone === "success" && "bg-success text-white",
              t.tone === "error" && "bg-danger text-white",
              t.tone === "info" && "bg-text text-bg",
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- Forms
export function SubmitButton({ children, variant = "primary", size = "md", className, pendingText, disabled }: {
  children: ReactNode; variant?: "primary" | "secondary" | "danger" | "success" | "ghost"; size?: "sm" | "md" | "lg"; className?: string; pendingText?: string; disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant={variant} size={size} className={className} disabled={pending || disabled} aria-busy={pending}>
      {pending ? pendingText ?? "Saving…" : children}
    </Button>
  );
}

type FormAction<T> = (prev: ActionState<T>, fd: FormData) => Promise<ActionState<T>>;

/** Form bound to a server action: shows errors inline, toasts success, blocks double submits. */
export function ActionForm<T>({ action, children, className, successMessage, redirectTo, onSuccess, resetOnSuccess, refresh = true }: {
  action: FormAction<T>; children: ReactNode; className?: string; successMessage?: string; redirectTo?: string | ((data: T | undefined) => string);
  onSuccess?: (data: T | undefined) => void; resetOnSuccess?: boolean; refresh?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const router = useRouter();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const closeModal = useContext(ModalCloseCtx);
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!state || handled.current === state.at) return;
    handled.current = state.at;
    if (state.ok) {
      const msg = state.message ?? successMessage;
      if (msg) toast({ tone: "success", text: msg });
      if (resetOnSuccess) formRef.current?.reset();
      onSuccess?.(state.data as T);
      closeModal?.();
      if (redirectTo) router.push(typeof redirectTo === "function" ? redirectTo(state.data as T) : redirectTo);
      else if (refresh) router.refresh();
    } else if (state.error) {
      toast({ tone: "error", text: state.error });
    }
  }, [state, successMessage, redirectTo, onSuccess, resetOnSuccess, refresh, router, toast, closeModal]);
  return (
    <form ref={formRef} action={formAction} className={className}>
      {children}
      {state && !state.ok && state.error ? (
        <p role="alert" className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{state.error}</p>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------- Action buttons with confirmation
export function ActionButton<T>({ action, children, confirm, confirmLabel = "Confirm", variant = "secondary", size = "md", className, successMessage, redirectTo, requireText, prompt, disabled }: {
  action: (input?: string) => Promise<ActionState<T>>;
  children: ReactNode; confirm?: ReactNode; confirmLabel?: string; variant?: "primary" | "secondary" | "danger" | "success" | "ghost";
  size?: "sm" | "md" | "lg"; className?: string; successMessage?: string; redirectTo?: string | ((d: T | undefined) => string);
  /** Require the user to type this word to confirm (dangerous actions). */
  requireText?: string;
  /** Ask for a free-text input (e.g. cancel reason) that is passed to the action. */
  prompt?: string;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const toast = useToast();

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const run = () =>
    start(async () => {
      setError(null);
      const res = await action(prompt ? input : undefined);
      if (res?.ok) {
        setOpen(false);
        const msg = res.message ?? successMessage;
        if (msg) toast({ tone: "success", text: msg });
        if (redirectTo) router.push(typeof redirectTo === "function" ? redirectTo(res.data as T) : redirectTo);
        else router.refresh();
      } else {
        const msg = res?.error ?? "Something went wrong";
        setError(msg);
        if (!confirm && !prompt) toast({ tone: "error", text: msg });
      }
    });

  const needsDialog = !!(confirm || prompt || requireText);
  return (
    <>
      <Button variant={variant} size={size} className={className} disabled={pending || disabled} aria-busy={pending}
        onClick={() => (needsDialog ? (setOpen(true), setTyped(""), setInput(""), setError(null)) : run())}>
        {pending && !needsDialog ? "Working…" : children}
      </Button>
      {needsDialog ? (
        <dialog ref={dialogRef} onClose={() => setOpen(false)} className="m-auto w-[min(92vw,30rem)] rounded-lg border border-border bg-surface p-0 text-text">
          <div className="p-5">
            <div className="text-sm">{confirm}</div>
            {prompt ? (
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-medium text-muted">{prompt}</span>
                <textarea autoFocus value={input} onChange={(e) => setInput(e.target.value)} className="min-h-20 w-full rounded-md border border-border-strong bg-surface p-2 text-sm" />
              </label>
            ) : null}
            {requireText ? (
              <label className="mt-3 block">
                <span className="mb-1 block text-xs font-medium text-muted">Type <b>{requireText}</b> to confirm</span>
                <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="h-10 w-full rounded-md border border-border-strong bg-surface px-3 text-sm" />
              </label>
            ) : null}
            {error ? <p role="alert" className="mt-3 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
          </div>
          <div className="flex justify-end gap-2 border-t border-border bg-surface-2 px-5 py-3">
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button>
            <Button variant={variant === "secondary" ? "primary" : variant} onClick={run}
              disabled={pending || (!!requireText && typed.trim().toUpperCase() !== requireText.toUpperCase()) || (!!prompt && !input.trim())}>
              {pending ? "Working…" : confirmLabel}
            </Button>
          </div>
        </dialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- Modal (generic)
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} className={cx("m-auto max-h-[90vh] rounded-lg border border-border bg-surface p-0 text-text", wide ? "w-[min(96vw,56rem)]" : "w-[min(94vw,32rem)]")}>
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="font-semibold">{title}</h2>
        <button type="button" onClick={onClose} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Close">✕</button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-5">{open ? children : null}</div>
    </dialog>
  );
}

const ModalCloseCtx = createContext<(() => void) | null>(null);

/** Button that opens a modal. Any ActionForm inside closes the modal when it succeeds. */
export function ModalButton({ label, title, children, variant = "secondary", size = "md", wide }: { label: ReactNode; title: ReactNode; children: ReactNode; variant?: "primary" | "secondary" | "ghost" | "danger"; size?: "sm" | "md" | "lg"; wide?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>{label}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title={title} wide={wide}>
        <ModalCloseCtx.Provider value={() => setOpen(false)}>{children}</ModalCloseCtx.Provider>
      </Modal>
    </>
  );
}
