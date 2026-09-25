import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp } from "@/lib/firebase/admin";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

export type AdminAccessResolution =
  | { status: "unauthenticated" }
  | { status: "blocked" }
  | { status: "allowed"; uid: string };

export async function resolveAdminAccess(cookie: string | undefined): Promise<AdminAccessResolution> {
  if (!cookie) return { status: "unauthenticated" };

  let uid: string;
  try {
    const decoded = await getAuth(firebaseAdminApp).verifySessionCookie(cookie, true);
    uid = decoded.uid;
  } catch {
    return { status: "unauthenticated" };
  }

  const envUids = process.env.CONECTWEB_ADMIN_UIDS || "";
  if (!envUids.trim()) {
    return { status: "blocked" };
  }

  const allowedUids = envUids
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  if (allowedUids.includes(uid)) {
    return { status: "allowed", uid };
  }

  return { status: "blocked" };
}
