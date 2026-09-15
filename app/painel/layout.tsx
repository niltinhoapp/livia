// Guarda de servidor do painel: sem cookie de sessão válido, redireciona
// para /login antes de renderizar qualquer página (config/agenda/conhecimento).
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME, resolvePanelAccess } from "@/lib/auth/session";
import { AppShell } from "@/components/layout/AppShell";

export default async function PainelLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const access = await resolvePanelAccess(cookie);
  if (access.status !== "allowed") redirect("/login?access=blocked");

  return <AppShell>{children}</AppShell>;
}
