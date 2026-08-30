// Guarda de servidor do painel: sem cookie de sessão válido, redireciona
// para /login antes de renderizar qualquer página (config/agenda/conhecimento).
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "firebase-admin/auth";
import { firebaseAdminApp } from "@/lib/firebase/admin";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";

export default async function PainelLayout({ children }: { children: ReactNode }) {
  const cookie = cookies().get(SESSION_COOKIE_NAME)?.value;
  let ok = false;
  if (cookie) {
    try {
      await getAuth(firebaseAdminApp).verifySessionCookie(cookie, true);
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) redirect("/login");

  return <AppShell>{children}</AppShell>;
}
