"use client";
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { MobileTabBar } from "./MobileTabBar";
import { Header } from "./Header";
import { useShellData } from "@/components/hooks/useShellData";

export function AppShell({ children }: { children: ReactNode }) {
  const { data, loading } = useShellData();
  const pathname = usePathname();
  const router = useRouter();

  // Conta nova (sem establishment ainda) cai direto no onboarding guiado, em
  // vez de abrir um formulário de configurações vazio sem contexto.
  useEffect(() => {
    if (!loading && data && data.exists === false && pathname !== "/painel/onboarding") {
      router.replace("/painel/onboarding");
    }
  }, [loading, data, pathname, router]);

  return (
    <div className="flex min-h-screen bg-line/20">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <Header />
        <main className="flex-1 px-4 pb-24 pt-6 sm:px-6 lg:pb-10">{children}</main>
      </div>
      <MobileTabBar />
    </div>
  );
}
