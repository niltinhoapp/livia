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
}

export function useShellData() {
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
  }, []);

  return { data, loading };
}
