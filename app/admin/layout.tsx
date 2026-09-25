import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { resolveAdminAccess } from "@/lib/auth/adminSession";
import { AdminShell } from "@/components/layout/AdminShell";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const access = await resolveAdminAccess(cookie);
  
  // Qualquer status diferente de 'allowed' leva o usuário para fora do admin
  // Redirecionamos para /login (ou /painel se preferir)
  if (access.status !== "allowed") {
    redirect("/login?access=blocked");
  }

  return <AdminShell>{children}</AdminShell>;
}
