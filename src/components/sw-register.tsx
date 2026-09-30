"use client";
import { useEffect } from "react";

/** Registers the service worker that caches the app shell and count screens for offline use. */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production" && !localStorage.getItem("sw-dev")) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) => console.warn("SW registration failed", e));
  }, []);
  return null;
}
