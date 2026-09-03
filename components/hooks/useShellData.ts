"use client";
// Dados leves usados só pelo "chrome" do painel (sidebar/header): nome do
// estabelecimento e status do WhatsApp. Cada página continua responsável por
// buscar seus próprios dados detalhados — isto NÃO substitui os fetches
// existentes em /painel/configuracoes, /painel/agenda, etc.
import { useEffect, useState } from "react";
import type { EstablishmentType } from "@/types";

export interface ShellData {
  name: string;
  type: EstablishmentType;
  exists: boolean;
  whatsappConnected: boolean;
  // false quando Establishment.status !== "active" (conta suspensa): a Livia
  // não atende e o dono precisa enxergar isso. O campo já vinha na resposta
  // de /api/establishment e era descartado aqui — nenhuma requisição nova.
  serviceActive: boolean;
}

// `refetchKey` (normalmente o pathname atual) força uma nova busca sempre
// que mudar. Sem isso, o hook buscava só uma vez por montagem do AppShell —
// então, depois de concluir o onboarding (establishment recém-criado) e
// navegar via router.push/replace (sem remontar o AppShell), `exists`
// continuava obsoleto (false), e o guard de onboarding em AppShell.tsx
// redirecionava de volta pra /painel/onboarding mesmo já configurado.
export function useShellData(refetchKey?: string) {
  const [data, setData] = useState<ShellData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/establishment").then((r) => r.json()),
      fetch("/api/whatsapp/connect").then((r) => r.json()),
    ])
      .then(([est, wa]) => {
        if (cancelled) return;
        setData({
          name: est.establishment?.name ?? "",
          type: est.establishment?.type ?? "outro",
          exists: Boolean(est.exists),
          whatsappConnected: Boolean(wa.connected),
          serviceActive: est.establishment?.status !== "suspended",
        });
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refetchKey]);

  return { data, loading };
}
