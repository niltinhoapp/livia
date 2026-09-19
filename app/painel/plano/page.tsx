"use client";
// Plano e cobrança — MVP Client-Ready (OT-07D) + contratação real via PIX
// (OT-07E2) + Hosted Checkout Asaas para cartão de crédito (OT de migração
// pro Hosted Checkout). Plano único real (Lívia, R$129/mês, 7 dias grátis);
// Pro/Premium só como "Em breve", sem preço nem seleção.
//
// FONTE DE VERDADE: mostrar o QR/copia-e-cola do Pix, ou o cliente retornar
// do Checkout hospedado, NUNCA significa pagamento confirmado — só o webhook
// (backend) decide billingStatus. Esta página NUNCA seta billingStatus=active
// sozinha a partir de query string/redirect do navegador. "Já paguei,
// atualizar" e o retorno do Checkout só refazem o GET /api/establishment já
// existente (sem polling automático/agressivo).
//
// CPF/CNPJ (fluxo Pix) só existe em estado de componente enquanto a
// requisição está em voo — nunca em localStorage/sessionStorage, limpo assim
// que enviado. O fluxo de cartão nunca coleta dado de cartão aqui — o
// backend só cria o Checkout e redireciona; os dados do cartão são
// digitados exclusivamente na página hospedada da Asaas.
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { CreditCard, QrCode, Clock, Info, Copy, RefreshCw, CheckCircle2 } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Field";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";
import { resolveTrialPhase } from "@/lib/billing/trialWindow";
import type { Establishment } from "@/types";

const FUTURE_PLANS = [
  { id: "pro", name: "Pro" },
  { id: "premium", name: "Premium" },
];

// OT-BILLING-UI-01: Hosted Checkout/Asaas aguardando suporte — contratação
// desabilitada SÓ no front (o fluxo abaixo continua intacto, incluindo a
// chamada real a POST /api/billing/subscribe). Reativar trocando esta
// constante para false quando o Asaas for resolvido.
const PAYMENT_TEMPORARILY_DISABLED = false;

type SubscribeStep = "idle" | "collecting" | "submitting" | "payment_required" | "processing" | "error";
// Estado independente do Pix (subscribeStep) porque os dois meios de
// pagamento podem estar em voo em momentos diferentes — nunca compartilham
// o mesmo step, senão um duplo clique alternando entre Pix/cartão poderia
// misturar mensagens de erro/loading de um meio com o botão do outro.
type CardCheckoutStep = "idle" | "redirecting" | "error";

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

function cardCheckoutErrorMessage(code: string | null): string {
  switch (code) {
    case "ESTABLISHMENT_NOT_FOUND":
    case "UNAUTHENTICATED":
      return "Não foi possível identificar sua conta. Atualize a página e tente novamente.";
    default:
      return "Não foi possível iniciar o pagamento por cartão agora. Tente novamente em instantes.";
  }
}

export default function PlanoPage() {
  return (
    <Suspense fallback={<PlanoSkeleton />}>
      <PlanoPageInner />
    </Suspense>
  );
}

function PlanoPageInner() {
  const searchParams = useSearchParams();
  // Só leitura, uma vez — nunca usado para decidir billingStatus (ver
  // cabeçalho do arquivo). Só controla qual banner de PROCESSAMENTO mostrar
  // enquanto o backend/webhook ainda não confirmou nada.
  const checkoutReturn = searchParams.get("checkout"); // "success" | "cancel" | "expired" | null

  const [establishment, setEstablishment] = useState<Establishment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [subscribeStep, setSubscribeStep] = useState<SubscribeStep>("idle");
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [payment, setPayment] = useState<PixPayment | null>(null);
  const [subscribeErrorCode, setSubscribeErrorCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [cardCheckoutStep, setCardCheckoutStep] = useState<CardCheckoutStep>("idle");
  const [cardCheckoutErrorCode, setCardCheckoutErrorCode] = useState<string | null>(null);

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

  // Retorno do Checkout (?checkout=success): UMA verificação a mais, não
  // polling — o webhook pode já ter confirmado antes do navegador terminar
  // o redirect de volta (webhook chegando antes do retorno é um cenário
  // real e válido), então vale a pena conferir uma vez; se ainda não
  // confirmou, o banner abaixo cobre isso e "Atualizar" fica disponível
  // pro cliente repetir manualmente, mesmo padrão do fluxo Pix.
  useEffect(() => {
    if (checkoutReturn === "success") {
      loadEstablishment();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutReturn]);

  if (loading) return <PlanoSkeleton />;

  const billing = establishment?.billing;
  const isActive = billing?.billingStatus === "active";
  // Fase 1 do gating de billing (redireciona pra esta página quando
  // suspended/canceled — ver AppShell.tsx): precisa de copy própria, senão
  // o tenant cai aqui e só vê o texto genérico "Ciclo mensal". `suspended`
  // ainda pode regularizar pagando a cobrança em aberto (payment_confirmed
  // é uma transição válida a partir de suspended); `canceled` NUNCA volta
  // sozinho por pagamento (deliberado na state machine) — exige reativação
  // administrativa, então não oferece o mesmo CTA de contratação.
  const isSuspended = billing?.billingStatus === "suspended";
  const isCanceled = billing?.billingStatus === "canceled";
  // Regra definitiva do trial (auditoria pré-primeiro-pagamento real):
  // calculado por TIMESTAMP (resolveTrialPhase, lib/billing/trialWindow.ts
  // — mesma fonte usada pelo backend nas duas rotas de pagamento e pelo
  // cron de expiração), nunca por "dia de calendário" nem duplicado aqui.
  // `trialPhase` só existe enquanto billingStatus ainda é literalmente
  // "trial" — uma vez suspenso de verdade pelo cron, isSuspended já cobre.
  const hasTrialData =
    billing?.billingStatus === "trial" && typeof billing.trialEndsAt === "number" && Number.isFinite(billing.trialEndsAt);
  const trialPhase = hasTrialData ? resolveTrialPhase(billing!.trialEndsAt!, Date.now()) : null;
  const isBeforePaymentWindow = trialPhase === "before_window";
  const isTrialFinalDay = trialPhase === "final_day";
  const isTrialGrace = trialPhase === "grace";
  // Tolerância de 24h já esgotada mas o cron diário ainda não persistiu
  // "suspended" — acesso já foi cortado em tempo real por canUseService
  // (stateMachine.ts), então a página trata como suspenso também, pra
  // nunca mostrar "ainda dá tempo" quando não dá mais.
  const isTrialGraceExpired = trialPhase === "expired";
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

  // Cria o Hosted Checkout no backend e redireciona o navegador pra lá —
  // nenhum dado de cartão passa por aqui. O retorno (?checkout=success/
  // cancel/expired) é só UX: o estado real só muda quando loadEstablishment
  // refletir o que o webhook já confirmou no backend (ver banner abaixo e o
  // efeito de refresh único ao montar com checkout=success).
  async function startCardCheckout() {
    if (cardCheckoutStep === "redirecting") return; // trava cliques repetidos
    setCardCheckoutStep("redirecting");
    setCardCheckoutErrorCode(null);
    try {
      const res = await fetch("/api/billing/checkout", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.status === 200 && data.status === "active") {
        setCardCheckoutStep("idle");
        await loadEstablishment();
        return;
      }
      if (res.status === 200 && typeof data.checkoutUrl === "string" && data.checkoutUrl) {
        window.location.href = data.checkoutUrl; // navega pra fora — nenhum estado local decide "pago"
        return;
      }
      if (res.status === 202) {
        setCardCheckoutStep("idle");
        return;
      }
      setCardCheckoutErrorCode(typeof data.error === "string" ? data.error : null);
      setCardCheckoutStep("error");
    } catch {
      setCardCheckoutErrorCode(null);
      setCardCheckoutStep("error");
    }
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
                {(isBeforePaymentWindow || isTrialFinalDay) && <StatusBadge tone="info">Período de teste</StatusBadge>}
                {(isTrialGrace || isTrialGraceExpired) && <StatusBadge tone="warning">Período de teste encerrado</StatusBadge>}
                {isSuspended && <StatusBadge tone="danger">Assinatura suspensa</StatusBadge>}
                {isCanceled && <StatusBadge tone="danger">Assinatura cancelada</StatusBadge>}
              </div>
              {isActive ? (
                <p className="mt-0.5 text-sm text-ink-500">Sua assinatura está em dia.</p>
              ) : isBeforePaymentWindow && billing?.trialEndsAt ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  Seu período gratuito está ativo. Termina em {new Date(billing.trialEndsAt).toLocaleDateString("pt-BR")} ·{" "}
                  {daysRemaining(billing.trialEndsAt)} {daysRemaining(billing.trialEndsAt) === 1 ? "dia restante" : "dias restantes"}
                  . As opções de pagamento ficam disponíveis no último dia do teste.
                </p>
              ) : isTrialFinalDay && billing?.trialEndsAt ? (
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-500">
                  <Clock className="h-3.5 w-3.5" aria-hidden />
                  Seu período gratuito termina em breve, em {new Date(billing.trialEndsAt).toLocaleDateString("pt-BR")}. Você já
                  pode pagar agora para evitar interrupção.
                </p>
              ) : isTrialGrace ? (
                <p className="mt-0.5 text-sm text-warning-fg">
                  Seu período gratuito terminou. Você tem até 24 horas para regularizar o pagamento antes da suspensão.
                </p>
              ) : isTrialGraceExpired ? (
                <p className="mt-0.5 text-sm text-danger-fg">
                  Seu período gratuito terminou. Regularize o pagamento para continuar usando a Lívia.
                </p>
              ) : isSuspended ? (
                <p className="mt-0.5 text-sm text-danger-fg">
                  Sua assinatura está suspensa por falta de pagamento. Regularize para voltar a usar o painel.
                </p>
              ) : isCanceled ? (
                <p className="mt-0.5 text-sm text-danger-fg">
                  Sua assinatura foi cancelada. Fale com o suporte da Lívia para reativar.
                </p>
              ) : (
                <p className="mt-0.5 text-sm text-ink-500">Ciclo mensal</p>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold text-ink-900">R$ 129</p>
            <p className="text-xs text-ink-400">por mês</p>
            {isBeforePaymentWindow && <p className="mt-1 text-xs text-ink-400">7 dias grátis para começar</p>}
          </div>
        </div>

        {/* -------- Cancelada: nunca reativa sozinha por pagamento (deliberado na
             state machine) — sem CTA de autoatendimento, só orientação. -------- */}
        {isCanceled && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-ink-500">
              Assinaturas canceladas não voltam automaticamente com um novo pagamento. Entre em contato com o
              suporte da Lívia para reativar sua conta.
            </p>
          </div>
        )}

        {/* -------- Contratação: Pix (fluxo direto atual) ou cartão (Hosted
             Checkout) — o cliente escolhe o meio ANTES de prosseguir; cada
             escolha segue um caminho de backend inteiramente separado.
             Nunca aparece antes de trialEndsAt-24h (regra definitiva do
             trial) — o backend rejeita de qualquer forma
             (TRIAL_PAYMENT_NOT_YET_AVAILABLE), isto é só a UI refletindo a
             mesma regra pra não oferecer um botão que a API recusaria. -------- */}
        {!isActive && !isCanceled && !isBeforePaymentWindow && subscribeStep === "idle" && cardCheckoutStep !== "error" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="mb-3 text-sm font-semibold text-ink-700">Como você quer pagar?</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={PAYMENT_TEMPORARILY_DISABLED} onClick={() => setSubscribeStep("collecting")}>
                <QrCode className="h-4 w-4" aria-hidden />
                {PAYMENT_TEMPORARILY_DISABLED
                  ? "Contratação em breve"
                  : hasPendingSubscription
                    ? "Ver cobrança Pix pendente"
                    : "Pagar com Pix"}
              </Button>
              <Button
                variant="secondary"
                disabled={PAYMENT_TEMPORARILY_DISABLED}
                loading={cardCheckoutStep === "redirecting"}
                onClick={startCardCheckout}
              >
                <CreditCard className="h-4 w-4" aria-hidden />
                Pagar com cartão de crédito
              </Button>
            </div>
            {PAYMENT_TEMPORARILY_DISABLED && (
              <p className="mt-2 text-xs text-ink-400">Pagamento temporariamente indisponível.</p>
            )}
            {cardCheckoutStep === "redirecting" && (
              <p className="mt-2 text-xs text-ink-400">Redirecionando para o pagamento seguro...</p>
            )}
          </div>
        )}

        {!isActive && cardCheckoutStep === "error" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-danger-fg">{cardCheckoutErrorMessage(cardCheckoutErrorCode)}</p>
            <Button className="mt-2" variant="secondary" size="sm" onClick={() => setCardCheckoutStep("idle")}>
              Tentar novamente
            </Button>
          </div>
        )}

        {/* -------- Retorno do Hosted Checkout: NUNCA marca "Pagamento
             confirmado" só porque existe ?checkout=success — o painel
             reflete o billingStatus persistido no backend; enquanto o
             webhook não confirmar, mostra processamento. -------- */}
        {!isActive && checkoutReturn === "success" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-ink-700">
              Pagamento recebido para processamento. Estamos aguardando a confirmação do Asaas.
            </p>
            <Button className="mt-2" variant="secondary" size="sm" onClick={refreshAfterPayment}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Atualizar
            </Button>
          </div>
        )}
        {!isActive && checkoutReturn === "cancel" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-ink-500">Pagamento por cartão cancelado. Você pode tentar novamente quando quiser.</p>
          </div>
        )}
        {!isActive && checkoutReturn === "expired" && (
          <div className="mt-5 border-t border-line/60 pt-4">
            <p className="text-sm text-ink-500">O link de pagamento expirou. Clique em "Pagar com cartão de crédito" para gerar um novo.</p>
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
