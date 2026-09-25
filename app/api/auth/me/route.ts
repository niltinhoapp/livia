import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp } from "@/lib/firebase/admin";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";

export async function GET(req: NextRequest) {
  const cookie = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (!cookie) return NextResponse.json({ user: null }, { status: 401 });

  try {
    const decoded = await getAuth(firebaseAdminApp).verifySessionCookie(cookie, true);
    const userRecord = await getAuth(firebaseAdminApp).getUser(decoded.uid);
    return NextResponse.json({
      user: {
        name: userRecord.displayName ?? null,
        email: userRecord.email ?? null,
        photo: userRecord.photoURL ?? null,
      },
    });
  } catch {
    return NextResponse.json({ user: null }, { status: 401 });
  }
}
