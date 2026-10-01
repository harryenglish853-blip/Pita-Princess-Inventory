import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { EMPLOYEE_COOKIE } from "@/lib/employee-cookie";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase.rpc("end_employee_session"); // no-op unless a shared-login employee is identified
  await supabase.auth.signOut();
  const res = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  res.cookies.delete(EMPLOYEE_COOKIE);
  return res;
}
