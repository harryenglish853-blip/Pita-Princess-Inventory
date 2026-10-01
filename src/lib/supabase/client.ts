"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";
import { getDeviceId } from "@/lib/device";
import { EMPLOYEE_HEADER, readEmployeeToken } from "@/lib/employee-cookie";

let client: SupabaseClient | undefined;

/** Browser Supabase client (singleton). Used for offline sync and live data. */
export function createClient(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: {
        headers: { "x-device-id": getDeviceId() },
        // The employee on a shared login can change (Switch person), so read it per request.
        fetch: (input, init) => {
          const headers = new Headers(init?.headers);
          const token = readEmployeeToken();
          if (token) headers.set(EMPLOYEE_HEADER, token);
          else headers.delete(EMPLOYEE_HEADER);
          return fetch(input, { ...init, headers });
        },
      },
    });
  }
  return client;
}
