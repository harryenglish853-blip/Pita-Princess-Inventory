"use client";
import { Button } from "./ui";
export function PrintButton({ label = "Print / PDF" }: { label?: string }) {
  return <Button onClick={() => window.print()}>{label}</Button>;
}
