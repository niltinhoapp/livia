// Autoridade administrativa da plataforma. Não depende de panelAccess: um
// tenant autorizado a usar o produto não se torna administrador por isso.
import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp } from "@/lib/firebase/admin";

export type PlatformAdminResolution =
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "authorized"; actorUid: string };

const FIREBASE_UID = /^[A-Za-z0-9:_-]{1,128}$/;

function configuredAdminUids(): Set<string> | null {
  const raw = process.env.PANEL_ADMIN_UIDS;
  if (!raw?.trim()) return null;

  const entries = raw.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !FIREBASE_UID.test(entry))) return null;
  return new Set(entries);
}

export async function requirePlatformAdmin(cookie: string | undefined): Promise<PlatformAdminResolution> {
  if (!cookie) return { status: "unauthenticated" };

  let actorUid: string;
  try {
    const decoded = await getAuth(firebaseAdminApp).verifySessionCookie(cookie, true);
    actorUid = decoded.uid;
  } catch {
    return { status: "unauthenticated" };
  }

  const adminUids = configuredAdminUids();
  if (!adminUids?.has(actorUid)) return { status: "forbidden" };
  return { status: "authorized", actorUid };
}
