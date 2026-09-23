"use client";
// CRM / Pipeline — exibe oportunidades detectadas pela Livia e o funil de
// conversão do dia. Consome APIs já existentes (GET /api/opportunities,
// GET /api/dashboard) sem criar nenhuma fonte de dados nova.
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, MessageCircle } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { Skeleton, SkeletonCard } from "@/components/ui/Skeleton";
import { PageHeader } from "@/components/ui/PageHeader";
import type { Opportunity, OpportunityType } from "@/types";
import type { FunnelResult } from "@/lib/ai/funnel";

interface DashboardMetrics {
  funnel: FunnelResult;
  oportunidadesAbertas: number;
}

const OPPORTUNITY_META: Record<OpportunityType, { label: string; tone: StatusTone }> = {
  handoff_waiting: { label: "Aguardando humano", tone: "danger" },
  appointment_incomplete: { label: "Agendamento incompleto", tone: "warning" },
  awaiting_confirmation: { label: "Aguardando confirmação", tone: "warning" },
  complaint_unresolved: { label: "Reclamação aberta", tone: "danger" },
  price_inquiry_no_booking: { label: "Perguntou preço", tone: "info" },
  cancelled_no_rebooking: { label: "Cancelou sem remarcar", tone: "warning" },
};

export default function CrmPage() {
  const [opportunities, setOpportunities] = useState<Opportunity[] | null>(null);
  const [funnel, setFunnel] = useState<FunnelResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const from = startOfDay.getTime();
    const to = from + 24 * 3600000;

    Promise.all([
      fetch("/api/opportunities").then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/dashboard?from=${from}&to=${to}`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([opp, metrics]) => {
        setOpportunities(opp?.opportunities ?? []);
        setFunnel((metrics as DashboardMetrics | null)?.funnel ?? null);
      })
      .catch(() => setError(true));
  }, []);

  if (error) return <ErrorState onRetry={() => window.location.reload()} />;

  if (opportunities === null) {
    return (
      <div className="mx-auto max-w-5xl">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="mt-2 h-7 w-40" />
        <Skeleton className="mb-6 mt-2 h-4 w-64" />
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
        <Skeleton className="mt-4 h-48 w-full rounded-card" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Pipeline de oportunidades"
        description="Oportunidades detectadas automaticamente pela Livia a partir das conversas reais."
      />

      {/* ---- Funil de hoje ---- */}
      {funnel && (
        <Card className="mb-5">
          <CardTitle>Funil de hoje</CardTitle>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3">
            <FunnelStep label="Atendimentos" value={funnel.atendimentos} />
            <FunnelStep label="Intenção de agendar" value={funnel.intencaoAgendar} />
            <FunnelStep label="Agendamentos concluídos" value={funnel.agendamentosConcluidos} tone="text-success-fg" />
            <FunnelStep label="Não concluídos" value={funnel.naoConcluidos} tone="text-warning-fg" />
          </div>
          {funnel.taxaConversao !== null && (
            <p className="mt-3 text-xs text-ink-500">
              Taxa de conversão hoje: <span className="font-semibold text-ink-900">{Math.round(funnel.taxaConversao * 100)}%</span>
            </p>
          )}
        </Card>
      )}

      {/* ---- Resumo ---- */}
      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="Oportunidades abertas" value={opportunities.length} tone={opportunities.length > 0 ? "warning" : "success"} />
        <StatCard
          label="Aguardando humano"
          value={opportunities.filter((o) => o.type === "handoff_waiting").length}
          tone="danger"
        />
        <StatCard
          label="Agendamentos incompletos"
          value={opportunities.filter((o) => o.type === "appointment_incomplete" || o.type === "awaiting_confirmation").length}
          tone="warning"
        />
      </div>

      {/* ---- Lista de oportunidades ---- */}
      <Card>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <CardTitle>Oportunidades</CardTitle>
            <p className="-mt-2 text-xs text-ink-500">Cada item abaixo tem evidência concreta — nada inventado pela IA.</p>
          </div>
        </div>

        {opportunities.length === 0 ? (
          <EmptyState title="Tudo limpo" description="Nenhuma oportunidade aberta no momento. A Livia monitora automaticamente." />
        ) : (
          <div className="divide-y divide-line">
            {opportunities.map((opp, idx) => {
              const meta = OPPORTUNITY_META[opp.type];
              return (
                <div key={`${opp.conversationId}-${opp.type}-${idx}`} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-ink-900">{opp.contactName ?? opp.contactPhone}</p>
                      <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-500">{opp.label}</p>
                    <p className="mt-0.5 text-[10px] text-ink-400">
                      {new Date(opp.detectedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                    </p>
                  </div>
                  <Link
                    href={`/painel/conversas?conversa=${encodeURIComponent(opp.conversationId)}`}
                    className="flex shrink-0 items-center gap-1 text-xs font-semibold text-primary hover:underline"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                    Ver conversa
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function FunnelStep({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface-muted/60 px-3 py-3 text-center">
      <p className={`text-2xl font-bold ${tone ?? "text-ink-900"}`}>{value}</p>
      <p className="mt-0.5 text-[11px] font-medium text-ink-500">{label}</p>
    </div>
  );
}
