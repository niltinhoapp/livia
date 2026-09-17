"use client";
// Plano e cobrança — MVP Client-Ready (OT-07D) + contratação real via PIX
// (OT-07E2). Plano único real (Lívia, R$129/mês, 7 dias grátis); Pro/Premium
// só como "Em breve", sem preço nem seleção.
//
// FONTE DE VERDADE: mostrar o QR/copia-e-cola NUNCA significa pagamento
// confirmado — só o webhook (backend) decide billingStatus. Esta página
// nunca seta billingStatus=active sozinha; "Já paguei, atualizar" só refaz
// o GET /api/establishment já existente (sem polling automático/agressivo).
//
// CPF/CNPJ só existe em estado de componente enquanto a requisição está em
// voo — nunca em localStorage/sessionStorage, limpo assim que enviado.
import { useCallback, useEffect, useState } from "react";
import { CreditCard, Clock, Info, Copy, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";
import type { Establishment } from "@/types";

const FUTURE_PLANS = [
  { id: "pro", name: "Pro" },
  { id: "premium", name: "Premium" },
];

type SubscribeStep = "idle" | "collecting" | "submitting" | "payment_required" | "processing" | "error";

interface PixPayment {
  pixCopyPaste: string;
  qrCode: string;
}

function daysRemaining(trialEndsAt: number): number {
  return Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

// Nunca exibe o texto bruto de erro do backend — só um mapeamento fixo e
// seguro por código conhecido, com fallback genérico.
function subscribeErrorMessage(code: string | null): string {
  switch (code) {
    case "INVALID_PAYLOAD":
      return "CPF ou CNPJ inválido. Confira o número e tente novamente.";
    case "ESTABLISHMENT_NOT_FOUND":
    case "UNAUTHENTICATED":
      return "Não foi possível identificar sua conta. Atualize a página e tente novamente.";
    default:
      return "Não foi possível processar sua contratação agora. Tente novamente em instantes.";
  }
}

export default function PlanoPage() {
  const [establishment, setEstablishment] = useState<Establishment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [subscribeStep, setSubscribeStep] = useState<SubscribeStep>("idle");
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [payment, setPayment] = useState<PixPayment | null>(null);
  const [subscribeErrorCode, setSubscribeErrorCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadEstablishment = useCallback(async () => {
    try {
      const res = await fetch("/api/establishment");
      if (!res.ok) throw new Error("failed");
      const data = await res.json();
      setEstablishment(data.establishment as Establishment);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    let active = true;
    loadEstablishment().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [loadEstablishment]);

  if (loading) return <PlanoSkeleton />;

  const billing = establishment?.billing;
  const isActive = billing?.billingStatus === "active";
  const hasTrialWindow = billing?.billingStatus === "trial" && typeof billing.trialEndsAt === "number";
  const trialActive = hasTrialWindow && billing!.trialEndsAt! > Date.now();
  const trialExpired = hasTrialWindow && !trialActive;
  const hasPendingSubscription = Boolean(billing?.externalSubscriptionId) && !isActive;

  async function startSubscribe(e: React.FormEvent) {
    e.preventDefault();
    if (subscribeStep === "submitting") return; // trava cliques repetidos
    const doc = cpfCnpj;
    setCpfCnpj(""); // nunca fica em memória além do necessário para esta requisição
    setSubscribeStep("submitting");
    setSubscribeErrorCode(null);
    try {
      const res = await fetch("/api/billing/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cpfCnpj: doc }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 200 && data.status === "active") {
        setSubscribeStep("idle");
        await loadEstablishment(); // reflete o novo billingStatus vindo do backend
        return;
      }
      if (res.status === 200 && data.status === "payment_required" && data.payment) {
        setPayment({ pixCopyPaste: data.payment.pixCopyPaste, qrCode: data.payment.qrCode });
        setSubscribeStep("payment_required");
        return;
      }
      if (res.status === 202) {
        setSubscribeStep("processing");
        return;
      }
      setSubscribeErrorCode(typeof data.error === "string" ? data.error : null);
      setSubscribeStep("error");
    } catch {
      setSubscribeErrorCode(null);
      setSubscribeStep("error");
    }
  }

  async function refreshAfterPayment() {
    await loadEstablishment();
  }

  async function copyPixCode() {
    if (!payment) return;
    try {
      await navigator.clipboard.writeText(payment.pixCopyPaste);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard indisponível neste navegador — o código já está visível
      // no campo de texto para cópia manual.
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Plano e cobrança" description="Sua assinatura da Lívia." />

      {error && (
        <div className="mb-5 flex items-start gap-3 rounded-control border border-warning/30 bg-warning-bg/40 px-4 py-3 text-sm text-warning-fg">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>Não foi possível carregar os dados do seu plano agora. Tente novamente mais tarde.</p>
        </div>
      )}

      {/* -------- Plano atual -------- */}
      <Card className="mb-5 border-primary/20 bg-gradient-to-br from-primary-light/40 to-white">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-primary text-white shadow-e2">
              <CreditCard className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <p className="text-lg font-bold text-ink-900">Lívia</p>
                {isActive && (
                  <StatusBadge tone="success">
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3" aria-hidden /> Assinatura ativa
                    </span>
                  </StatusBadge>
                )}
                {!isActive && trialActive && <StatusBadge tone="info">Período de teste</StatusBadge>}
                {!isActive && trialExpired && <StatusBadge tone="warning">Período de teste encerrado</StatusBadge>}
              </div>
              {isActive ? (
                <p className="mt-0.5 text-sm text-ink-500">Sua assinatura está em dia.</p>
              ) : trialActive && billing?.trialEndsAt ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  Termina em {new Date(billing.trialEndsAt).toLocaleDateString("pt-BR")} ·{" "}
                  {daysRemaining(billing.trialEndsAt)} {daysRemaining(billing.trialEndsAt) === 1 ? "dia restante" : "dias restantes"}
                </p>
              ) : trialExpired ? (
                <p className="mt-0.5 text-sm text-ink-500">Seu período de teste terminou.</p>
              ) : (
                <p className="mt-0.5 text-sm text-ink-500">Ciclo mensal</p>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-ink-900">R$ 129</p>
            <p className="text-xs text-ink-400">por mês</p>
            {!isActive && !trialExpired && <p className="mt-1 text-xs text-ink-400">7 dias grátis para começar</p>}
          </div>
        </div>

        {/* -------- Contratação -------- */}
        {!isActive && subscribeStep === "idle" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <Button onClick={() => setSubscribeStep("collecting")}>
              {hasPendingSubscription ? "Ver cobrança pendente" : "Contratar Lívia"}
            </Button>
          </div>
        )}

        {!isActive && (subscribeStep === "collecting" || subscribeStep === "submitting") && (
          <form onSubmit={startSubscribe} className="mt-5 border-t border-line/60 pt-4">
            <Label hint="usado só para gerar a cobrança no Asaas">CPF ou CNPJ</Label>
            <p className="mb-2 text-xs text-ink-400">
              Precisamos desse dado para emitir a cobrança da sua assinatura. Ele não fica salvo aqui — vai direto para o
              processador de pagamento.
            </p>
            <Input
              value={cpfCnpj}
              onChange={(e) => setCpfCnpj(e.target.value)}
              placeholder="000.000.000-00"
              inputMode="numeric"
              disabled={subscribeStep === "submitting"}
              required
              autoFocus
            />
            <div className="mt-3 flex gap-2">
              <Button type="submit" loading={subscribeStep === "submitting"}>
                Confirmar contratação
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={subscribeStep === "submitting"}
                onClick={() => {
                  setCpfCnpj("");
                  setSubscribeStep("idle");
                }}
              >
                Cancelar
              </Button>
            </div>
          </form>
        )}

        {!isActive && subscribeStep === "payment_required" && payment && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="mb-3 text-sm font-semibold text-ink-700">Pague com Pix para ativar sua assinatura</p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <img
                src={`data:image/png;base64,${payment.qrCode}`}
                alt="QR Code Pix para pagamento"
                className="h-40 w-40 rounded-control border border-line"
              />
              <div className="w-full flex-1">
                <Label>Ou copie o código Pix</Label>
                <Input value={payment.pixCopyPaste} readOnly onFocus={(e) => e.target.select()} />
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={copyPixCode}>
                    <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? "Copiado!" : "Copiar código"}
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={refreshAfterPayment}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Já paguei, atualizar
                  </Button>
                </div>
                <p className="mt-2 text-xs text-ink-400">
                  Assim que o pagamento for identificado, sua assinatura é ativada automaticamente.
                </p>
              </div>
            </div>
          </div>
        )}

        {!isActive && subscribeStep === "processing" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-ink-500">Estamos confirmando sua contratação. Tente novamente em instantes.</p>
            <Button className="mt-2" variant="secondary" size="sm" onClick={() => setSubscribeStep("collecting")}>
              Tentar novamente
            </Button>
          </div>
        )}

        {!isActive && subscribeStep === "error" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-danger-fg">{subscribeErrorMessage(subscribeErrorCode)}</p>
            <Button className="mt-2" variant="secondary" size="sm" onClick={() => setSubscribeStep("collecting")}>
              Tentar novamente
            </Button>
          </div>
        )}
      </Card>

      {/* -------- Planos futuros -------- */}
      <CardTitle className="mb-3">Outros planos</CardTitle>
      <div className="mb-6 grid gap-4 md:grid-cols-2">
        {FUTURE_PLANS.map((plan) => (
          <Card key={plan.id} className="flex flex-col opacity-70">
            <div className="flex items-center justify-between gap-2">
              <p className="text-base font-bold text-ink-900">{plan.name}</p>
              <StatusBadge tone="neutral">Em breve</StatusBadge>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PlanoSkeleton() {
  return (
    <div className="mx-auto max-w-4xl">
      <Skeleton className="h-7 w-52" />
      <Skeleton className="mb-6 mt-2 h-4 w-96 max-w-full" />
      <Skeleton className="mb-5 h-32 w-full rounded-card" />
      <div className="grid gap-4 md:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
