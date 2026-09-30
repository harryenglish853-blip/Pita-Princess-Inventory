/** Stable per-device id (audit trail "DEVICE"). Stored in localStorage and a cookie for server requests. */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "server";
  try {
    let id = localStorage.getItem("device_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("device_id", id);
    }
    if (!document.cookie.includes("device_id=")) {
      document.cookie = `device_id=${id}; path=/; max-age=31536000; samesite=lax`;
    }
    return id;
  } catch {
    return "unknown";
  }
}
