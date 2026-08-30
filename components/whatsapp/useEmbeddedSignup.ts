"use client";
// Hook isolado que encapsula TODA a mecânica do Meta Embedded Signup real:
// carregar o SDK, abrir o popup (FB.login) e sincronizar os dois canais
// assíncronos que ele produz — o `code` (callback do FB.login) e o
// `waba_id`/`phone_number_id` (postMessage WA_EMBEDDED_SIGNUP) — chegando em
// qualquer ordem. Só entrega o resultado ao chamador quando os 3 valores
// estiverem presentes; nunca entrega dado parcial.
//
// Nada aqui toca Firestore, Graph API server-side ou POST /api/whatsapp/connect
// — isso é responsabilidade de quem usa o hook (app/painel/whatsapp/page.tsx).
// Nenhum valor sensível (code) é armazenado em localStorage/sessionStorage/
// cookie/URL — só em refs em memória, apagados assim que entregues.
import { useCallback, useEffect, useRef } from "react";
import { loadFacebookSdk } from "./metaSdk";
import { isAllowedEmbeddedSignupOrigin, parseEmbeddedSignupMessage } from "./embeddedSignupMessage";

export interface EmbeddedSignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

interface UseEmbeddedSignupOptions {
  appId: string;
  configId: string;
  // Popup foi aberto (FB.login chamado) — bom momento para trocar a fase
  // visual para "aguardando a Meta".
  onPopupOpened?: () => void;
  // Usuário fechou/cancelou o popup sem concluir, ou o evento CANCEL chegou.
  onCancelled?: () => void;
  // SDK não carregou, ou qualquer falha antes de ter os 3 valores.
  onFailed?: (reason: string) => void;
  // Os 3 valores (code, wabaId, phoneNumberId) chegaram — nunca chamado com
  // dado incompleto.
  onCompleted: (result: EmbeddedSignupResult) => void;
}

export function useEmbeddedSignup({
  appId,
  configId,
  onPopupOpened,
  onCancelled,
  onFailed,
  onCompleted,
}: UseEmbeddedSignupOptions) {
  // Em memória apenas — nunca persistido. Refs porque os dois canais chegam
  // de callbacks assíncronos independentes (FB.login vs. postMessage).
  const codeRef = useRef<string | null>(null);
  const idsRef = useRef<{ wabaId: string; phoneNumberId: string } | null>(null);
  // Garante no máximo UM POST válido por sessão de signup (requisito de
  // evitar dupla submissão), mesmo se os eventos disparassem mais de uma vez.
  const completedRef = useRef(false);

  // Identifica a tentativa atual (incrementado a cada start()) e qual foi a
  // última tentativa explicitamente cancelada. Junto, os dois protegem
  // contra dois tipos de callback/evento tardio:
  //   - de uma tentativa CANCELADA que ainda não completou quando o CANCEL
  //     chegou (cancelledAttemptIdRef marca exatamente essa tentativa);
  //   - de uma tentativa ANTERIOR à atual, já superada por um novo start()
  //     (attemptIdRef muda, então o id capturado na tentativa antiga nunca
  //     mais bate com o id "current").
  const attemptIdRef = useRef(0);
  const cancelledAttemptIdRef = useRef<number | null>(null);

  // Sempre a versão mais recente do callback, sem precisar re-registrar o
  // listener de postMessage a cada render.
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const onCancelledRef = useRef(onCancelled);
  onCancelledRef.current = onCancelled;

  // Só true para a tentativa que é, ao mesmo tempo, a atual E não foi
  // cancelada — usado por todo callback/evento antes de agir.
  const isAttemptValid = useCallback(
    (attemptId: number) => attemptId === attemptIdRef.current && cancelledAttemptIdRef.current !== attemptId,
    [],
  );

  const handleCancel = useCallback(
    (attemptId: number) => {
      if (!isAttemptValid(attemptId)) return; // já cancelada ou já superada — não faz nada
      cancelledAttemptIdRef.current = attemptId; // invalida esta tentativa imediatamente
      codeRef.current = null;
      idsRef.current = null;
      onCancelledRef.current?.();
    },
    [isAttemptValid],
  );

  const tryComplete = useCallback(
    (attemptId: number) => {
      if (!isAttemptValid(attemptId)) return; // tentativa cancelada ou já superada
      if (completedRef.current) return;
      if (!codeRef.current || !idsRef.current) return; // nunca entrega parcial
      completedRef.current = true;
      const result: EmbeddedSignupResult = { code: codeRef.current, ...idsRef.current };
      // Limpa a memória local imediatamente após entregar.
      codeRef.current = null;
      idsRef.current = null;
      onCompletedRef.current(result);
    },
    [isAttemptValid],
  );

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isAllowedEmbeddedSignupOrigin(event.origin)) return; // origem não confiável
      const parsed = parseEmbeddedSignupMessage(event.data);
      if (!parsed) return; // formato inesperado

      const attemptId = attemptIdRef.current;
      if (parsed.event === "CANCEL") {
        handleCancel(attemptId);
        return;
      }
      if (parsed.event === "FINISH" && parsed.wabaId && parsed.phoneNumberId) {
        if (!isAttemptValid(attemptId)) return; // FINISH tardio de tentativa já cancelada/superada
        idsRef.current = { wabaId: parsed.wabaId, phoneNumberId: parsed.phoneNumberId };
        tryComplete(attemptId);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [handleCancel, isAttemptValid, tryComplete]);

  const start = useCallback(async () => {
    // Nova tentativa — supera qualquer tentativa anterior (cancelada ou não):
    // o id novo nunca mais bate com o que ficou capturado em closures/refs
    // antigos, então qualquer callback tardio deles é ignorado por
    // isAttemptValid.
    const attemptId = (attemptIdRef.current += 1);
    cancelledAttemptIdRef.current = null;
    completedRef.current = false;
    codeRef.current = null;
    idsRef.current = null;

    if (!appId || !configId) {
      onFailed?.("missing-config");
      return;
    }

    try {
      await loadFacebookSdk(appId);
    } catch {
      onFailed?.("sdk-load-failed");
      return;
    }
    if (!window.FB) {
      onFailed?.("sdk-unavailable");
      return;
    }
    if (!isAttemptValid(attemptId)) return; // uma tentativa mais nova já começou enquanto o SDK carregava

    onPopupOpened?.();
    window.FB.login(
      (response) => {
        if (!isAttemptValid(attemptId)) return; // tentativa cancelada ou já superada
        const code = response.authResponse?.code;
        if (!code) {
          // Usuário fechou o popup ou cancelou antes de autorizar.
          handleCancel(attemptId);
          return;
        }
        codeRef.current = code;
        tryComplete(attemptId);
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, sessionInfoVersion: "3" },
      },
    );
  }, [appId, configId, handleCancel, isAttemptValid, onFailed, onPopupOpened, tryComplete]);

  return { start };
}
