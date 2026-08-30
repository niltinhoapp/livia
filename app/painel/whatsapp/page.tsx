"use client";
// Painel: conexão de WhatsApp (Embedded Signup) — SÓ a experiência visual.
//
// A integração real (Facebook JS SDK, FB.login, listener WA_EMBEDDED_SIGNUP,
// captura de code/waba_id/phone_number_id e o POST real para
// /api/whatsapp/connect) é implementação sensível reservada para uma etapa
// própria — ver comentário em components/whatsapp/WhatsAppConnectionCard.tsx.
// Esta página só consulta o status real (GET, contrato já existente) e
// mostra os estados visuais; o clique em "Conectar" ainda não abre a Meta de
// verdade.
import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { WhatsAppConnectionCard, type WhatsAppPhase } from "@/components/whatsapp/WhatsAppConnectionCard";

interface ConnectStatus {
  connected: boolean;
  connectedAt?: number;
}

export default function WhatsAppPage() {
  const [status, setStatus] = useState<ConnectStatus | null>(null);
  const [error, setError] = useState(false);
  const [phase, setPhase] = useState<WhatsAppPhase>("idle");

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

  // Ponto de integração futuro (ver cabeçalho do arquivo): por enquanto só
  // demonstra a transição visual, sem SDK da Meta carregado.
  const handleConnectClick = useCallback(() => {
    setPhase("connecting");
    setTimeout(() => {
      setPhase("idle");
    }, 900);
  }, []);

  if (error) return <ErrorState onRetry={load} />;
  if (!status) return <LoadingState />;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="WhatsApp" description="Conecte o número da sua empresa para a Livia atender por lá." />

      <WhatsAppConnectionCard
        phase={phase}
        connectedAt={status.connectedAt}
        onConnectClick={handleConnectClick}
        onRetry={load}
      />

      {process.env.NODE_ENV === "development" && (
        <DevPhaseSwitcher phase={phase} onChange={setPhase} />
      )}
    </div>
  );
}

// Só existe em desenvolvimento (compilado fora do bundle de produção) — deixa
// os 8 estados visuais fáceis de validar sem depender da integração real com
// a Meta, que ainda não existe.
function DevPhaseSwitcher({ phase, onChange }: { phase: WhatsAppPhase; onChange: (p: WhatsAppPhase) => void }) {
  const phases: WhatsAppPhase[] = [
    "idle",
    "connecting",
    "awaiting-meta",
    "finalizing",
    "connected",
    "in-progress",
    "error-recoverable",
    "error-attention",
  ];
  return (
    <div className="mt-6 rounded-control border border-dashed border-line p-3">
      <p className="mb-2 text-xs font-semibold text-ink-400">
        Pré-visualização de estados (só em desenvolvimento)
      </p>
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
