"use server";
import { cookies } from "next/headers";
import { getSession, LOCATION_COOKIE } from "@/lib/session";

export async function switchLocation(id: string) {
  const session = await getSession();
  if (!session?.locations.some((l) => l.id === id)) return;
  (await cookies()).set(LOCATION_COOKIE, id, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true });
}
