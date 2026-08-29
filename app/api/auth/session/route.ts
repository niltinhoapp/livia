// POST   -> recebe o ID token do Firebase (Google ou e-mail/senha, já
//           autenticado no client) e cria um cookie de sessão httpOnly.
// DELETE -> encerra a sessão (logout).
import { NextRequest, NextResponse } from "next/server";
import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp } from "@/lib/firebase/admin";
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from "@/lib/auth/session";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { idToken?: string } | null;
  if (!body?.idToken) {
    return NextResponse.json({ error: "idToken obrigatório" }, { status: 400 });
  }

  try {
    // Valida o token antes de emitir o cookie (rejeita token expirado/inválido
    // com uma mensagem clara, em vez de deixar createSessionCookie falhar).
    await getAuth(firebaseAdminApp).verifyIdToken(body.idToken);
    const cookie = await getAuth(firebaseAdminApp).createSessionCookie(body.idToken, {
      expiresIn: SESSION_MAX_AGE_MS,
    });

    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE_NAME, cookie, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: Math.floor(SESSION_MAX_AGE_MS / 1000),
    });
    return res;
  } catch (err) {
    console.error("[auth/session] token inválido:", err);
    return NextResponse.json({ error: "login inválido ou expirado" }, { status: 401 });
  }
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
