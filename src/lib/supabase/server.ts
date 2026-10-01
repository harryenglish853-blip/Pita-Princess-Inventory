import "server-only";
import { createServerClient } from "@supabase/ssr";
import { createClient as createPlainClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";
import { EMPLOYEE_COOKIE, EMPLOYEE_HEADER } from "@/lib/employee-cookie";

/** Supabase client bound to the signed-in user's session (RLS applies). */
export async function createClient() {
  const cookieStore = await cookies();
  const h = await headers();
  const forwarded: Record<string, string> = {};
  const ua = h.get("user-agent");
  if (ua) forwarded["user-agent"] = ua;
  const ip = h.get("x-forwarded-for") ?? h.get("x-real-ip");
  if (ip) forwarded["x-forwarded-for"] = ip;
  const device = cookieStore.get("device_id")?.value;
  if (device) forwarded["x-device-id"] = device;
  const employee = cookieStore.get(EMPLOYEE_COOKIE)?.value;
  if (employee && /^[0-9a-f]{64}$/.test(employee)) forwarded[EMPLOYEE_HEADER] = employee;

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: forwarded },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component: the proxy refreshes the session instead.
        }
      },
    },
  });
}

/** Service-role client. Only for privileged admin operations (e.g. creating auth users). */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createPlainClient(SUPABASE_URL, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
