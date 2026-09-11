"use client";
// Hook isolado que encapsula TODA a mecânica do Meta Embedded Signup real.
// Cloud API continua sendo o padrão; Coexistence adiciona somente o
// featureType exigido pela Meta no mesmo FB.login.
import { useCallback, useEffect, useRef } from "react";
import { loadFacebookSdk } from "./metaSdk";
import { isAllowedEmbeddedSignupOrigin, parseEmbeddedSignupMessage } from "./embeddedSignupMessage";

export type WhatsappSignupMode = "cloud_api" | "coexistence";

export interface EmbeddedSignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  connectionMode: WhatsappSignupMode;
}

interface UseEmbeddedSignupOptions {
  appId: string;
  configId: string;
  mode?: WhatsappSignupMode;
  onPopupOpened?: () => void;
  onCancelled?: () => void;
  onFailed?: (reason: string) => void;
  onCompleted: (result: EmbeddedSignupResult) => void;
}

export function useEmbeddedSignup({
  appId,
  configId,
  mode = "cloud_api",
  onPopupOpened,
  onCancelled,
  onFailed,
  onCompleted,
}: UseEmbeddedSignupOptions) {
  const codeRef = useRef<string | null>(null);
  const idsRef = useRef<{ wabaId: string; phoneNumberId: string } | null>(null);
  const completedRef = useRef(false);
  const attemptIdRef = useRef(0);
  const cancelledAttemptIdRef = useRef<number | null>(null);

  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  const onCancelledRef = useRef(onCancelled);
  onCancelledRef.current = onCancelled;

  const isAttemptValid = useCallback(
    (attemptId: number) => attemptId === attemptIdRef.current && cancelledAttemptIdRef.current !== attemptId,
    [],
  );

  const handleCancel = useCallback(
    (attemptId: number) => {
      if (!isAttemptValid(attemptId)) return;
      cancelledAttemptIdRef.current = attemptId;
      codeRef.current = null;
      idsRef.current = null;
      onCancelledRef.current?.();
    },
    [isAttemptValid],
  );

  const tryComplete = useCallback(
    (attemptId: number) => {
      if (!isAttemptValid(attemptId)) return;
      if (completedRef.current) return;
      if (!codeRef.current || !idsRef.current) return;
      completedRef.current = true;
      const result: EmbeddedSignupResult = {
        code: codeRef.current,
        ...idsRef.current,
        connectionMode: mode,
      };
      codeRef.current = null;
      idsRef.current = null;
      onCompletedRef.current(result);
    },
    [isAttemptValid, mode],
  );

  const activeListenerRef = useRef<((event: MessageEvent) => void) | null>(null);

  const detachMessageListener = useCallback(() => {
    if (activeListenerRef.current) {
      window.removeEventListener("message", activeListenerRef.current);
      activeListenerRef.current = null;
    }
  }, []);

  const attachMessageListener = useCallback(
    (attemptId: number) => {
      detachMessageListener();
      const onMessage = (event: MessageEvent) => {
        if (!isAllowedEmbeddedSignupOrigin(event.origin)) return;
        const parsed = parseEmbeddedSignupMessage(event.data);
        if (!parsed) return;

        if (parsed.event === "CANCEL") {
          handleCancel(attemptId);
          return;
        }
        if (parsed.event === "FINISH" && parsed.wabaId && parsed.phoneNumberId) {
          if (!isAttemptValid(attemptId)) return;
          idsRef.current = { wabaId: parsed.wabaId, phoneNumberId: parsed.phoneNumberId };
          tryComplete(attemptId);
        }
      };
      activeListenerRef.current = onMessage;
      window.addEventListener("message", onMessage);
    },
    [detachMessageListener, handleCancel, isAttemptValid, tryComplete],
  );

  useEffect(() => () => detachMessageListener(), [detachMessageListener]);

  const start = useCallback(async () => {
    const attemptId = (attemptIdRef.current += 1);
    detachMessageListener();
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
    if (!isAttemptValid(attemptId)) return;

    attachMessageListener(attemptId);
    onPopupOpened?.();
    window.FB.login(
      (response) => {
        if (!isAttemptValid(attemptId)) return;
        const code = response.authResponse?.code;
        if (!code) {
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
        extras: {
          setup: {},
          sessionInfoVersion: "3",
          ...(mode === "coexistence" ? { featureType: "whatsapp_business_app_onboarding" } : {}),
        },
      },
    );
  }, [
    appId,
    configId,
    mode,
    attachMessageListener,
    detachMessageListener,
    handleCancel,
    isAttemptValid,
    onFailed,
    onPopupOpened,
    tryComplete,
  ]);

  return { start };
}
