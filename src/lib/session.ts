import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Permission } from "@/lib/permissions";

export type LocationCtx = {
  id: string;
  organization_id: string;
  code: string;
  name: string;
  timezone: string;
  region_id: string | null;
  district_id: string | null;
  market: string | null;
  permissions: Permission[];
};

export type SessionCtx = {
  user: { id: string; email: string; full_name: string | null; default_location_id: string | null };
  organizations: { id: string; name: string; currency: string; shared_login?: boolean; settings?: { ordering_enabled?: boolean } }[];
  locations: LocationCtx[];
  org_permissions: { organization_id: string; permission: Permission }[];
  roles: { role: string; name: string; scope_type: string; scope_id: string }[];
  /** Person identified by name + PIN on a shared login. */
  employee: { id: string; display_name: string } | null;
};

export const LOCATION_COOKIE = "loc";

/** Loads the signed-in user's organizations, locations and permissions (once per request). */
export const getSession = cache(async (): Promise<SessionCtx | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_session_context");
  if (error || !data) return null;
  return data as SessionCtx;
});

export type AppContext = SessionCtx & { location: LocationCtx; organizationId: string };

/** Session + current location, redirecting to login/onboarding when needed. */
export const requireContext = cache(async (): Promise<AppContext> => {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.locations.length === 0) redirect("/onboarding");
  const jar = await cookies();
  const wanted = jar.get(LOCATION_COOKIE)?.value ?? session.user.default_location_id;
  const location = session.locations.find((l) => l.id === wanted) ?? session.locations[0];
  const ctx = { ...session, location, organizationId: location.organization_id };
  // A shared login must say who is using it before anything else.
  if (isSharedLogin(ctx) && !ctx.employee) redirect("/who");
  return ctx;
});

/** The login is shared by several employees (each identifies with name + PIN). */
export function isSharedLogin(ctx: SessionCtx & { organizationId: string }): boolean {
  return ctx.organizations.find((o) => o.id === ctx.organizationId)?.shared_login === true;
}

/** Name to show for the person acting: the identified employee, else the login's name. */
export function actorName(ctx: SessionCtx): string {
  return ctx.employee?.display_name ?? ctx.user.full_name ?? ctx.user.email;
}

export function can(ctx: AppContext, perm: Permission, locationId?: string): boolean {
  const loc = locationId ? ctx.locations.find((l) => l.id === locationId) : ctx.location;
  return !!loc?.permissions.includes(perm);
}

/** Permission held at organization scope (required for corporate master data). */
export function canOrg(ctx: AppContext, perm: Permission): boolean {
  return ctx.org_permissions.some((p) => p.organization_id === ctx.organizationId && p.permission === perm);
}

export async function requirePermission(perm: Permission): Promise<AppContext> {
  const ctx = await requireContext();
  if (!can(ctx, perm)) redirect(`/denied?perm=${encodeURIComponent(perm)}`);
  return ctx;
}

/**
 * Purchase orders are optional: many stores order in each vendor's own app and
 * only record deliveries here. Off unless the organization turns it on.
 */
export function orderingEnabled(ctx: AppContext): boolean {
  return ctx.organizations.find((o) => o.id === ctx.organizationId)?.settings?.ordering_enabled === true;
}

/**
 * Front-line staff (no count review / management rights) get the intentionally
 * simple interface: receive, waste, transfer, tasks. Permissions are still
 * enforced by the database; this only decides what the screens show.
 */
export function isEmployeeMode(ctx: AppContext): boolean {
  return !can(ctx, "inventory.review") && !can(ctx, "reports.view");
}

const EMPLOYEE_NAV = new Set(["/", "/receiving", "/waste", "/transfers", "/tasks", "/counts"]);

/** Navigation the user can see: permissions plus organization features. */
export function visibleNav<T extends { href: string; perm?: Permission; feature?: "ordering" }>(ctx: AppContext, items: T[]): T[] {
  const ordering = orderingEnabled(ctx);
  const employee = isEmployeeMode(ctx);
  return items.filter((i) => (!i.perm || can(ctx, i.perm)) && (i.feature !== "ordering" || ordering) && (!employee || EMPLOYEE_NAV.has(i.href)));
}
