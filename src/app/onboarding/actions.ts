"use server";
import { createClient } from "@/lib/supabase/server";
import { fail, ok, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

export async function createOrganization(_: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_organization", {
    p_name: str(fd, "org_name"),
    p_location_name: str(fd, "location_name"),
    p_location_code: str(fd, "location_code"),
    p_timezone: str(fd, "timezone") || "America/New_York",
  });
  if (error) return fail(error);
  return ok("Restaurant created");
}
