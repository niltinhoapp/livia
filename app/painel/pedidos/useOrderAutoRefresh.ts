"use client";

import { useEffect, useRef } from "react";

export const ORDER_REFRESH_INTERVAL_MS = 30_000;

// Polling moderado, somente com a aba visível. A API resolve o tenant pela
// sessão httpOnly; assim não expomos a coleção Firestore ao browser nem
// criamos listener sem regras de segurança verificadas neste projeto.
export function useOrderAutoRefresh(refresh: (signal: AbortSignal) => Promise<void>): void {
  const inFlight = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible" || inFlight.current || disposed) return;
      inFlight.current = true;
      controller = new AbortController();
      void refreshRef.current(controller.signal).catch(() => undefined).finally(() => {
        inFlight.current = false;
      });
    };
    const interval = window.setInterval(refreshIfVisible, ORDER_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, []);
}
