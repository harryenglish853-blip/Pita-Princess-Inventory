"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { fail, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

function safeNext(next: string) {
  return next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

export async function signIn(_: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: str(fd, "email"), password: str(fd, "password") });
  if (error) return fail({ message: error.message === "Invalid login credentials" ? "Email or password is incorrect." : error.message });
  redirect(safeNext(str(fd, "next") || "/"));
}

export async function signUp(_: ActionState, fd: FormData): Promise<ActionState> {
  const password = str(fd, "password");
  if (password.length < 8) return fail({ message: "Use at least 8 characters for the password." });
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: str(fd, "email"),
    password,
    options: { data: { full_name: str(fd, "full_name") }, emailRedirectTo: `${await origin()}/auth/callback?next=/onboarding` },
  });
  if (error) return fail(error);
  if (!data.session) return { ok: true, message: "Check your email to confirm your account, then sign in.", at: Date.now() };
  redirect("/onboarding");
}

async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Emails a reset link. Always answers the same way so it can't be used to discover accounts. */
export async function requestPasswordReset(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = str(fd, "email");
  if (!email) return fail({ message: "Enter your email" });
  const supabase = await createClient();
  await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${await origin()}/auth/callback?next=/account?reset=1` });
  return { ok: true, message: "If that email has an account, a reset link is on its way. Open it on this device.", at: Date.now() };
}

export async function changePassword(_: ActionState, fd: FormData): Promise<ActionState> {
  const password = str(fd, "password");
  if (password.length < 8) return fail({ message: "Use at least 8 characters." });
  if (password !== str(fd, "confirm")) return fail({ message: "The two passwords don't match." });
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return fail(error);
  return { ok: true, message: "Password changed", at: Date.now() };
}
