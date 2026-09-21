"use client";

import { useEffect } from "react";

export const ORDER_REFRESH_INTERVAL_MS = 30_000;

// Polling moderado, somente com a aba visível. A API resolve o tenant pela
// sessão httpOnly; assim não expomos a coleção Firestore ao browser nem
// criamos listener sem regras de segurança verificadas neste projeto.
export function useOrderAutoRefresh(refresh: () => Promise<void>): void {
  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh().catch(() => undefined);
    };
    const interval = window.setInterval(refreshIfVisible, ORDER_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh]);
}
