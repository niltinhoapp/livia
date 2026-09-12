"use client";
// Painel: conexão de WhatsApp via Meta Embedded Signup — fluxo real.
//
// A integração sensível (SDK JS da Meta, FB.login, listener
// WA_EMBEDDED_SIGNUP, sincronização de code+waba_id+phone_number_id) vive em
// components/whatsapp/useEmbeddedSignup.ts — esta página só orquestra as
// transições de fase visual e chama o backend já existente
// (POST /api/whatsapp/connect) quando os 3 valores estão prontos.
//
// Nunca exibe wabaId, phoneNumberId, accessToken, PIN ou termos técnicos da
// Meta ao lojista — só os 8 estados visuais já definidos em
// WhatsAppConnectionCard.
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WhatsAppConnectionCard, type WhatsAppPhase } from "@/components/whatsapp/WhatsAppConnectionCard";
import { useEmbeddedSignup, type EmbeddedSignupResult } from "@/components/whatsapp/useEmbeddedSignup";
import { mapErrorToPhase } from "@/components/whatsapp/errorMapping";

const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID ?? "";
const ES_CONFIG_ID = process.env.NEXT_PUBLIC_WHATSAPP_ES_CONFIG_ID ?? "";

interface ConnectStatus {
  connected: boolean;
  connectedAt?: number;
}

export default function WhatsAppPage() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [error, setError] = useState(false);
  const [phase, setPhase] = useState<WhatsAppPhase>("idle");
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const load = useCallback(() => {
    setError(false);
    setStatus(null);
    fetch("/api/whatsapp/connect")
      .then((r) => r.json())
      .then((j) => {
        setStatus({ connected: Boolean(j.connected), connectedAt: j.connectedAt });
        setPhase(j.connected ? "connected" : "idle");
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const finalizeConnection = useCallback(
    async (result: EmbeddedSignupResult) => {
      setPhase("finalizing");
      try {
        const res = await fetch("/api/whatsapp/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(result),
        });
        if (res.ok) {
          setPhase("connected");
          load();
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setPhase(mapErrorToPhase(body.error ?? ""));
      } catch {
        setPhase("error-recoverable");
      }
    },
    [load],
  );

  const handlePopupOpened = useCallback(() => {
    setPhase("awaiting-meta");
  }, []);
  const handleCancelled = useCallback(() => setPhase("idle"), []);
  const handleFailed = useCallback(() => setPhase("error-recoverable"), []);

  const { start } = useEmbeddedSignup({
    appId: META_APP_ID,
    configId: ES_CONFIG_ID,
    mode: "coexistence",
    onPopupOpened: handlePopupOpened,
    onCancelled: handleCancelled,
    onFailed: handleFailed,
    onCompleted: finalizeConnection,
  });

  const handleConnectClick = useCallback(() => {
    setPhase("connecting");
    start();
  }, [start]);

  const handleDisconnectConfirm = useCallback(async () => {
    setConfirmDisconnect(false);
    setPhase("disconnecting");
    try {
      const res = await fetch("/api/whatsapp/disconnect", { method: "POST" });
      if (res.ok) {
        load();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setPhase(mapErrorToPhase(body.error ?? ""));
    } catch {
      setPhase("error-recoverable");
    }
  }, [load]);

  if (error) return <ErrorState onRetry={load} />;
  if (!status) return <LoadingState />;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="WhatsApp" description="Conecte o número da sua empresa para a Livia atender por lá." />

      <WhatsAppConnectionCard
        phase={phase}
        connectedAt={status.connectedAt}
        onConnectClick={handleConnectClick}
        onDisconnectClick={() => setConfirmDisconnect(true)}
        onRetry={load}
      />

      <ConfirmDialog
        open={confirmDisconnect}
        title="Desconectar o WhatsApp?"
        description={
          "A Livia para de responder pelo seu WhatsApp. Seu número continua funcionando normalmente, e " +
          "suas conversas, agendamentos e informações do negócio continuam salvos. Você pode reconectar " +
          "o mesmo número quando quiser."
        }
        confirmLabel="Desconectar"
        cancelLabel="Cancelar"
        danger
        onConfirm={handleDisconnectConfirm}
        onCancel={() => setConfirmDisconnect(false)}
      />

      {process.env.NODE_ENV === "development" && (
        <DevPhaseSwitcher phase={phase} onChange={setPhase} />
      )}
    </div>
  );
}

function DevPhaseSwitcher({ phase, onChange }: { phase: WhatsAppPhase; onChange: (p: WhatsAppPhase) => void }) {
  const phases: WhatsAppPhase[] = [
    "idle",
    "connecting",
    "awaiting-meta",
    "finalizing",
    "connected",
    "disconnecting",
    "in-progress",
    "error-recoverable",
    "error-attention",
    "error-number-in-use",
  ];
  return (
    <div className="mt-6 rounded-control border border-dashed border-line p-3">
      <p className="mb-2 text-xs font-semibold text-ink-400">Pré-visualização de estados (só em desenvolvimento)</p>
      <div className="flex flex-wrap gap-1.5">
        {phases.map((p) => (
          <button
            key={p}
            onClick={() => onChange(p)}
            className={`rounded-control border px-2 py-1 text-xs ${
              phase === p ? "border-primary bg-primary-light text-primary" : "border-line text-ink-500"
            }`}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}
