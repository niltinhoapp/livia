"use client";
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { MobileTabBar } from "./MobileTabBar";
import { Header } from "./Header";
import { useShellData } from "@/components/hooks/useShellData";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // refetchKey = pathname: revalida "exists" a cada navegação, pra nunca
  // decidir o redirect de onboarding com dado obsoleto (ver useShellData.ts).
  const { data, loading } = useShellData(pathname);

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
        <Header data={data} />
        {data && !data.serviceActive ? (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 sm:px-6">
            <strong className="font-semibold">Atendimento pausado.</strong> A Livia não está respondendo
            automaticamente no WhatsApp: sua conta está suspensa. As mensagens dos clientes continuam sendo
            registradas em Conversas. Fale com o suporte para reativar.
          </div>
        ) : null}
        <main className="flex-1 px-4 pb-24 pt-6 sm:px-6 lg:pb-10">{children}</main>
      </div>
      <MobileTabBar />
    </div>
  );
}
