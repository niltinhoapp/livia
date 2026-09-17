"use client";
// Plano e cobrança — MVP Client-Ready (OT-07D). Plano único real (Lívia,
// R$129/mês, 7 dias grátis); Pro/Premium só como "Em breve", sem preço nem
// seleção. Checkout ainda não existe: nenhuma ação de assinatura é
// prometida — ações indisponíveis ficam ocultas, nunca como botão falso.
import { useEffect, useState } from "react";
import { CreditCard, Clock, Info } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";
import type { Establishment } from "@/types";

const FUTURE_PLANS = [
  { id: "pro", name: "Pro" },
  { id: "premium", name: "Premium" },
];

function daysRemaining(trialEndsAt: number): number {
  return Math.max(0, Math.ceil((trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)));
}

export default function PlanoPage() {
  const [establishment, setEstablishment] = useState<Establishment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/establishment")
      .then((res) => {
        if (!res.ok) throw new Error("failed");
        return res.json();
      })
      .then((data) => {
        if (active) setEstablishment(data.establishment as Establishment);
      })
      .catch(() => {
        if (active) setError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <PlanoSkeleton />;

  const billing = establishment?.billing;
  const hasTrialWindow = billing?.billingStatus === "trial" && typeof billing.trialEndsAt === "number";
  const trialActive = hasTrialWindow && billing!.trialEndsAt! > Date.now();
  const trialExpired = hasTrialWindow && !trialActive;

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
                {trialActive && <StatusBadge tone="info">Período de teste</StatusBadge>}
                {trialExpired && <StatusBadge tone="warning">Período de teste encerrado</StatusBadge>}
              </div>
              {trialActive && billing?.trialEndsAt ? (
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
            {!trialExpired && <p className="mt-1 text-xs text-ink-400">7 dias grátis para começar</p>}
          </div>
        </div>
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
