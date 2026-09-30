"use server";
import { createAdminClient, createClient } from "@/lib/supabase/server";
import { requireContext, can, canOrg } from "@/lib/session";
import { fail, ok, optNum, optStr, str } from "@/lib/actions";
import type { ActionState } from "@/lib/action-types";

/** Adds a person: creates their login (if new) and grants a scoped role. The role grant is authorised by the database. */
export async function inviteUser(_: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  if (!ctx.locations.some((l) => l.permissions.includes("users.manage")) && !canOrg(ctx, "users.manage")) {
    return fail({ message: "You do not have permission to manage users." });
  }
  const email = str(fd, "email").toLowerCase();
  const password = str(fd, "password");
  const fullName = str(fd, "full_name");
  const [scopeType, scopeId] = str(fd, "scope").split(":");
  if (!scopeType || !scopeId) return fail({ message: "Choose where the role applies" });
  if (!email || !fullName) return fail({ message: "Name and email are required" });
  const admin = createAdminClient();
  const { data: existing } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  let userId = existing?.id as string | undefined;
  let created = false;
  if (!userId) {
    if (password.length < 8) return fail({ message: "Set a temporary password of at least 8 characters" });
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error) return fail(error);
    userId = data.user.id;
    created = true;
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_role", {
    p_org: ctx.organizationId, p_user: userId, p_role_key: str(fd, "role"), p_scope_type: scopeType, p_scope_id: scopeId,
  });
  if (error) {
    if (created) await admin.auth.admin.deleteUser(userId); // roll back the login we just created
    return fail(error);
  }
  return ok(created ? `${fullName} added. Share the temporary password securely.` : `Role granted to ${email}`);
}

export async function grantRole(userId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const [scopeType, scopeId] = str(fd, "scope").split(":");
  const { error } = await supabase.rpc("assign_role", {
    p_org: ctx.organizationId, p_user: userId, p_role_key: str(fd, "role"), p_scope_type: scopeType, p_scope_id: scopeId,
  });
  if (error) return fail(error);
  return ok("Role granted");
}

export async function revokeRole(userRoleId: string): Promise<ActionState> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_role", { p_user_role: userRoleId });
  if (error) return fail(error);
  return ok("Role removed");
}

export async function setMemberActive(userId: string, active: boolean): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_member_active", { p_org: ctx.organizationId, p_user: userId, p_active: active });
  if (error) return fail(error);
  return ok(active ? "User reactivated" : "User deactivated — they can no longer sign in to this organization");
}

export async function saveLocation(id: string | null, _: ActionState, fd: FormData): Promise<ActionState<{ id: string }>> {
  try {
    const ctx = await requireContext();
    const supabase = await createClient();
    const row: Record<string, unknown> = {
      name: str(fd, "name"), code: str(fd, "code"), timezone: str(fd, "timezone") || "America/New_York",
      address_line1: optStr(fd, "address_line1"), city: optStr(fd, "city"), state: optStr(fd, "state"), postal_code: optStr(fd, "postal_code"),
      phone: optStr(fd, "phone"), market: optStr(fd, "market"), region_id: optStr(fd, "region_id"), district_id: optStr(fd, "district_id"),
      count_variance_pct_tolerance: optNum(fd, "count_variance_pct_tolerance") ?? "10",
      count_variance_value_tolerance: optNum(fd, "count_variance_value_tolerance") ?? "50",
      invoice_tolerance: optNum(fd, "invoice_tolerance") ?? "1",
      price_alert_pct: optNum(fd, "price_alert_pct") ?? "5",
      active: fd.get("active") !== null ? fd.get("active") === "on" : true,
    };
    // Store managers with settings.manage may change operating tolerances, not the hierarchy.
    if (id && !canOrg(ctx, "locations.manage")) {
      if (!can(ctx, "settings.manage", id)) return fail({ message: "You do not have permission to change this location." });
      for (const k of ["name", "code", "region_id", "district_id", "market", "active"]) delete row[k];
    }
    const { data, error } = id
      ? await supabase.from("locations").update(row).eq("id", id).select("id")
      : await supabase.from("locations").insert({ ...row, organization_id: ctx.organizationId }).select("id");
    if (error) return fail(error);
    if (!data?.length) return fail({ message: "You do not have permission to change locations." });
    return ok("Location saved", { id: data[0].id });
  } catch (e) { return fail(e as Error); }
}

export async function saveHierarchy(kind: "regions" | "districts", _: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const row: Record<string, unknown> = { organization_id: ctx.organizationId, name: str(fd, "name"), code: optStr(fd, "code") };
  if (kind === "districts") row.region_id = optStr(fd, "region_id");
  const { error } = await supabase.from(kind).insert(row);
  if (error) return fail(error);
  return ok(kind === "regions" ? "Region added" : "District added");
}

/** Turns the purchase-order screens on or off for the whole organization. */
export async function setOrderingEnabled(enabled: boolean): Promise<ActionState> {
  const ctx = await requireContext();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_organization_setting", { p_org: ctx.organizationId, p_key: "ordering_enabled", p_value: enabled });
  if (error) return fail(error);
  return ok(enabled ? "Ordering turned on" : "Ordering turned off: deliveries are logged from invoices");
}
