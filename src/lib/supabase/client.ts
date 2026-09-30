"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "./env";
import { getDeviceId } from "@/lib/device";

let client: SupabaseClient | undefined;

/** Browser Supabase client (singleton). Used for offline sync and live data. */
export function createClient(): SupabaseClient {
  if (!client) {
    client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { "x-device-id": getDeviceId() } },
    });
  }
  return client;
}
