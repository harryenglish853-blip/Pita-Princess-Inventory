"use client";
import { useEffect, useRef, useState } from "react";
import { Button, cx, inputBase } from "@/components/ui";

type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };

/**
 * Camera barcode scanning via the BarcodeDetector API (Chrome/Android, Safari 17+),
 * with a text field that also accepts Bluetooth/USB scanners (they type + Enter).
 */
export function BarcodeScanner({ onDetected, onClose }: { onDetected: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [manual, setManual] = useState("");
  const [status, setStatus] = useState<string>("Starting camera…");
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const W = window as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector };
    (async () => {
      if (!W.BarcodeDetector || !navigator.mediaDevices?.getUserMedia) { setStatus("Camera scanning is not supported on this device. Type or scan with a hardware scanner."); return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) return;
        video.current!.srcObject = stream;
        await video.current!.play();
        const detector = new W.BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "qr_code", "itf"] });
        setStatus("Point the camera at a barcode");
        timer = setInterval(async () => {
          if (!video.current || video.current.readyState < 2) return;
          const found = await detector.detect(video.current).catch(() => []);
          if (found[0]?.rawValue) { clearInterval(timer); navigator.vibrate?.(60); onDetected(found[0].rawValue); }
        }, 250);
      } catch {
        setStatus("Camera permission was denied. Type the barcode instead.");
      }
    })();
    return () => { stopped = true; clearInterval(timer); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onDetected]);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-black/80 p-4" role="dialog" aria-modal aria-label="Scan barcode">
      <div className="mx-auto w-full max-w-md rounded-lg bg-surface p-4">
        <div className="relative aspect-video overflow-hidden rounded-md bg-black">
          <video ref={video} className="h-full w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 bg-danger/80" />
        </div>
        <p className="mt-2 text-sm text-muted">{status}</p>
        <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) onDetected(manual.trim()); }}>
          <input autoFocus inputMode="numeric" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Barcode / UPC" aria-label="Barcode"
            className={cx(inputBase, "flex-1")} />
          <Button type="submit" variant="primary">Find</Button>
        </form>
        <Button className="mt-2 w-full" variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
