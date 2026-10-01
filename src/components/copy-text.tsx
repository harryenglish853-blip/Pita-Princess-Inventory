"use client";
import { useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "./ui";
import { Modal, useToast } from "./client";

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copies text to the clipboard; if the browser refuses, shows the text so it can be copied by hand. */
export function CopyTextButton({ text, label = "Copy", copiedMessage = "Copied", variant = "secondary", size = "md", className, testId }: {
  text: string | (() => string); label?: string; copiedMessage?: string; variant?: "primary" | "secondary" | "ghost"; size?: "sm" | "md" | "lg"; className?: string; testId?: string;
}) {
  const toast = useToast();
  const [fallback, setFallback] = useState<string | null>(null);
  return (
    <>
      <Button variant={variant} size={size} className={className} data-testid={testId}
        onClick={async () => {
          const t = typeof text === "function" ? text() : text;
          if (await writeClipboard(t)) toast({ tone: "success", text: copiedMessage });
          else setFallback(t);
        }}>
        <Copy className="h-4 w-4" /> {label}
      </Button>
      <Modal open={fallback !== null} onClose={() => setFallback(null)} title="Copy this list">
        <p className="mb-2 text-sm text-muted">This browser blocked automatic copying. Select the text below and copy it.</p>
        <textarea readOnly value={fallback ?? ""} className="h-64 w-full rounded-md border border-border-strong bg-surface p-2 font-mono text-sm"
          onFocus={(e) => e.currentTarget.select()} autoFocus />
      </Modal>
    </>
  );
}
