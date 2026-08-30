"use client";
// Carregamento do SDK JS oficial da Meta (Facebook) — SÓ no client, SÓ para
// abrir o popup do Embedded Signup real. Este módulo nunca deve ser
// importado por código server-side, e nunca referencia META_APP_SECRET (que
// só existe em lib/whatsapp/embedded.ts, server-only).
declare global {
  interface Window {
    FB?: {
      init: (options: Record<string, unknown>) => void;
      login: (
        callback: (response: { authResponse?: { code?: string } }) => void,
        options: Record<string, unknown>,
      ) => void;
    };
    fbAsyncInit?: () => void;
  }
}

const FB_SDK_URL = "https://connect.facebook.net/en_US/sdk.js";
const FB_SDK_SCRIPT_ID = "facebook-jssdk";
// Mesma versão da Graph API usada no backend (GRAPH_VERSION em
// lib/whatsapp/embedded.ts) — mantida em sincronia manualmente, de propósito
// (este arquivo não importa nada do backend, para não misturar client/server).
const GRAPH_VERSION = "v24.0";

let loadPromise: Promise<void> | null = null;

// Injeta o script oficial da Meta uma única vez por carregamento de página
// (mesmo que várias partes da UI chamem isto, o SDK só é solicitado uma vez).
export function loadFacebookSdk(appId: string): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("loadFacebookSdk: chamado fora do client."));
  }
  if (window.FB) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB?.init({
        appId,
        autoLogAppEvents: true,
        xfbml: false,
        version: GRAPH_VERSION,
      });
      resolve();
    };

    if (document.getElementById(FB_SDK_SCRIPT_ID)) {
      // Script já solicitado por outra chamada — fbAsyncInit acima ainda
      // será disparado pelo SDK quando terminar de carregar.
      return;
    }

    const script = document.createElement("script");
    script.id = FB_SDK_SCRIPT_ID;
    script.src = FB_SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => {
      loadPromise = null; // permite tentar de novo numa próxima chamada
      reject(new Error("loadFacebookSdk: falha ao carregar o SDK da Meta."));
    };
    document.body.appendChild(script);
  });

  return loadPromise;
}
