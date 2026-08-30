"use client";
// Componente 100% visual da conexão de WhatsApp (Embedded Signup). Não sabe
// nada sobre FB.login, SDK da Meta ou o POST para /api/whatsapp/connect —
// isso é responsabilidade de quem usa este componente (hoje,
// app/painel/whatsapp/page.tsx + components/whatsapp/useEmbeddedSignup.ts).
// `onConnectClick` é só o gatilho; a fase (`phase`) é controlada de fora.
//
// Nunca exibe wabaId, phoneNumberId, accessToken, PIN ou termos técnicos da
// Meta — só o que o lojista precisa entender.
import { CheckCircle2, Loader2, MessageCircle, AlertTriangle, Clock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export type WhatsAppPhase =
  | "idle" // não conectado, pronto pra iniciar
  | "connecting" // botão clicado, abrindo o fluxo
  | "awaiting-meta" // popup aberto, aguardando o lojista na Meta
  | "finalizing" // popup fechou, backend processando (POST /api/whatsapp/connect)
  | "connected" // sucesso
  | "in-progress" // CONNECTION_IN_PROGRESS / ALREADY_CONNECTED — já tem uma tentativa rodando
  | "error-recoverable" // EXCHANGE_FAILED, STALE_ATTEMPT, INVALID_PAYLOAD, INTERNAL_ERROR — só tentar de novo
  | "error-attention"; // OWNERSHIP_MISMATCH, SUBSCRIBE_FAILED, REGISTER_FAILED — algo a checar na Meta

interface WhatsAppConnectionCardProps {
  phase: WhatsAppPhase;
  connectedAt?: number | null;
  onConnectClick: () => void;
  onRetry: () => void;
}

export function WhatsAppConnectionCard({ phase, connectedAt, onConnectClick, onRetry }: WhatsAppConnectionCardProps) {
  if (phase === "connected") {
    return (
      <Card className="border-success/30 bg-success-bg/30">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-success-bg p-2.5 text-success-fg">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <div>
            <p className="font-semibold text-ink-900">WhatsApp conectado</p>
            <p className="mt-1 text-sm text-ink-500">
              A Livia já pode responder pelo WhatsApp do seu negócio
              {connectedAt ? ` desde ${new Date(connectedAt).toLocaleDateString("pt-BR")}` : ""}.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (phase === "connecting" || phase === "awaiting-meta" || phase === "finalizing") {
    const label =
      phase === "connecting"
        ? "Abrindo a conexão com a Meta…"
        : phase === "awaiting-meta"
          ? "Siga os passos na janela da Meta para escolher seu número…"
          : "Finalizando a conexão…";
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm font-medium text-ink-700">{label}</p>
        </div>
      </Card>
    );
  }

  if (phase === "in-progress") {
    return (
      <Card className="border-warning/30 bg-warning-bg/30">
        <div className="flex items-start gap-4">
          <div className="rounded-full bg-warning-bg p-2.5 text-warning-fg">
            <Clock className="h-6 w-6" />
          </div>
          <div className="flex-1">
            <p className="font-semibold text-ink-900">Já existe uma conexão em andamento</p>
            <p className="mt-1 text-sm text-ink-500">Aguarde alguns instantes e tente novamente.</p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  if (phase === "error-recoverable" || phase === "error-attention") {
    const attention = phase === "error-attention";
    return (
      <Card className={attention ? "border-danger/30 bg-danger-bg/20" : "border-warning/30 bg-warning-bg/20"}>
        <div className="flex items-start gap-4">
          <div className={`rounded-full p-2.5 ${attention ? "bg-danger-bg text-danger-fg" : "bg-warning-bg text-warning-fg"}`}>
            {attention ? <ShieldAlert className="h-6 w-6" /> : <AlertTriangle className="h-6 w-6" />}
          </div>
          <div className="flex-1">
            <p className="font-semibold text-ink-900">
              {attention ? "Não conseguimos concluir a conexão" : "Algo deu errado ao conectar"}
            </p>
            <p className="mt-1 text-sm text-ink-500">
              {attention
                ? "Verifique se você escolheu o número correto na Meta e tente novamente."
                : "Pode ter sido algo temporário. Tente novamente."}
            </p>
            <Button size="sm" variant="secondary" className="mt-3" onClick={onRetry}>
              Tentar novamente
            </Button>
          </div>
        </div>
      </Card>
    );
  }

  // idle
  return (
    <Card>
      <div className="flex flex-col items-center gap-4 py-4 text-center">
        <div className="rounded-full bg-primary-light p-3 text-primary">
          <MessageCircle className="h-7 w-7" />
        </div>
        <div>
          <p className="font-semibold text-ink-900">Conecte o WhatsApp do seu negócio</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-ink-500">
            Clique abaixo, entre com sua conta da Meta, escolha seu número de WhatsApp e pronto — a Livia
            já passa a atender por lá.
          </p>
        </div>
        <Button onClick={onConnectClick}>Conectar WhatsApp</Button>
      </div>
    </Card>
  );
}
