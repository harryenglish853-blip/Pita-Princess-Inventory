"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { fail, ok } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";
import { EMPLOYEE_COOKIE, EMPLOYEE_SESSION_HOURS } from "@/lib/employee-cookie";

type StartResult = { ok: boolean; token?: string; display_name?: string; error?: string; attempts_left?: number; locked?: boolean };

/** Verifies an employee's PIN (in the database) and remembers who is using this device. */
export async function identifyEmployee(employeeId: string, pin: string): Promise<ActionState<{ name: string }>> {
  if (!/^[0-9a-f-]{36}$/.test(employeeId) || !/^[0-9]{4}$/.test(pin)) return fail({ message: "Enter your 4-digit PIN" });
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_employee_session", { p_employee: employeeId, p_pin: pin });
  if (error) return fail(error);
  const res = data as StartResult;
  if (!res.ok || !res.token) {
    const left = res.attempts_left;
    return fail({ message: left !== undefined && left > 0 ? `${res.error}. ${left} attempt${left === 1 ? "" : "s"} left.` : res.error ?? "Incorrect PIN" });
  }
  const jar = await cookies();
  jar.set(EMPLOYEE_COOKIE, res.token, {
    path: "/", sameSite: "lax", secure: process.env.NODE_ENV === "production", httpOnly: false,
    maxAge: EMPLOYEE_SESSION_HOURS * 3600,
  });
  return ok(`Hi ${res.display_name}`, { name: res.display_name ?? "" });
}

/** Ends the current person's session on this device and returns to the name picker. */
export async function switchEmployee(): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("end_employee_session");
  (await cookies()).delete(EMPLOYEE_COOKIE);
  redirect("/who");
}
