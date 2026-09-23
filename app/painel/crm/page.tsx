"use client";
// CRM / Pipeline — exibe oportunidades detectadas pela Livia e o funil de
// conversão do dia. Consome APIs já existentes (GET /api/opportunities,
// GET /api/dashboard) sem criar nenhuma fonte de dados nova.
import { useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, MessageCircle, X } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
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

  // Estados do Modal de Detalhes
  const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);
  const [details, setDetails] = useState<{ summary?: string; status?: string } | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [acting, setActing] = useState(false);

  const loadData = () => {
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
  };

  useEffect(() => {
    loadData();
  }, []);

  function handleOpenDetails(opp: Opportunity) {
    setSelectedOpp(opp);
    setDetails(null);
    setLoadingDetails(true);
    fetch(`/api/conversations/${opp.conversationId}`)
      .then((r) => r.json())
      .then((j) => {
        setDetails({
          summary: j.conversation?.summary,
          status: j.conversation?.status,
        });
      })
      .finally(() => setLoadingDetails(false));
  }

  async function handleTakeOver() {
    if (!selectedOpp) return;
    setActing(true);
    try {
      const res = await fetch(`/api/conversations/${selectedOpp.conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "assume" }),
      });
      if (res.ok) {
        setSelectedOpp(null);
        loadData(); // Atualiza o pipeline para o card sumir ou mudar
      }
    } finally {
      setActing(false);
    }
  }

  if (error) return <ErrorState onRetry={loadData} />;

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

      {/* ---- Pipeline Visual (Kanban) ---- */}
      <div className="mb-4">
        <h2 className="text-lg font-bold text-ink-900">Pipeline</h2>
        <p className="text-sm text-ink-500">Acompanhe as oportunidades organizadas por estágio.</p>
      </div>

      <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
        <KanbanColumn
          title="Precisa de Atenção"
          description="Ação imediata necessária"
          tone="danger"
          items={opportunities.filter((o) => o.type === "handoff_waiting" || o.type === "complaint_unresolved")}
          onCardClick={handleOpenDetails}
        />
        <KanbanColumn
          title="Em Negociação"
          description="Agendamentos pausados"
          tone="warning"
          items={opportunities.filter((o) => o.type === "appointment_incomplete" || o.type === "awaiting_confirmation")}
          onCardClick={handleOpenDetails}
        />
        <KanbanColumn
          title="Resgate"
          description="Potencial venda/recuperação"
          tone="info"
          items={opportunities.filter((o) => o.type === "price_inquiry_no_booking" || o.type === "cancelled_no_rebooking")}
          onCardClick={handleOpenDetails}
        />
      </div>

      {/* MODAL DE DETALHES RÁPIDOS */}
      <Dialog.Root open={!!selectedOpp} onOpenChange={(open) => !open && setSelectedOpp(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-ink-900/40 backdrop-blur-[1px]" />
          <Dialog.Content className="fixed right-0 top-0 z-50 flex h-[100dvh] w-full max-w-sm flex-col bg-white shadow-xl focus:outline-none sm:w-[400px]">
            {selectedOpp && (
              <>
                <div className="flex items-center justify-between border-b border-line px-5 py-4">
                  <div>
                    <Dialog.Title className="text-base font-semibold text-ink-900">
                      {selectedOpp.contactName ?? selectedOpp.contactPhone}
                    </Dialog.Title>
                    <Dialog.Description className="mt-0.5 text-xs text-ink-500">
                      Detectado às {new Date(selectedOpp.detectedAt).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </Dialog.Description>
                  </div>
                  <button onClick={() => setSelectedOpp(null)} className="rounded-control p-2 text-ink-400 hover:bg-ink-50 hover:text-ink-600">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-5">
                  <div className="mb-6">
                    <p className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-400">Motivo</p>
                    <StatusBadge tone={OPPORTUNITY_META[selectedOpp.type].tone}>
                      {OPPORTUNITY_META[selectedOpp.type].label}
                    </StatusBadge>
                    <p className="mt-2 text-sm text-ink-700">{selectedOpp.label}</p>
                  </div>

                  <div>
                    <p className="mb-2 text-xs font-bold uppercase tracking-wider text-ink-400">Resumo da IA</p>
                    {loadingDetails ? (
                      <div className="space-y-2">
                        <Skeleton className="h-4 w-full" />
                        <Skeleton className="h-4 w-5/6" />
                        <Skeleton className="h-4 w-4/6" />
                      </div>
                    ) : (
                      <div className="rounded-lg bg-surface-muted p-3 text-sm text-ink-800">
                        {details?.summary ? (
                          <p className="whitespace-pre-wrap">{details.summary}</p>
                        ) : (
                          <p className="italic text-ink-400">Nenhum resumo disponível ainda.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-line bg-surface-muted/30 p-5">
                  <div className="flex flex-col gap-2">
                    <Button
                      variant="primary"
                      onClick={handleTakeOver}
                      disabled={acting || loadingDetails || details?.status === "human"}
                    >
                      {acting ? "Assumindo..." : details?.status === "human" ? "Já em atendimento" : "Assumir Conversa"}
                    </Button>
                    <Link
                      href={`/painel/conversas?conversa=${encodeURIComponent(selectedOpp.conversationId)}`}
                      className="block"
                    >
                      <Button variant="secondary" className="w-full">
                        Ir para chat completo
                      </Button>
                    </Link>
                  </div>
                </div>
              </>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
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

function KanbanColumn({
  title,
  description,
  tone,
  items,
  onCardClick,
}: {
  title: string;
  description: string;
  tone: StatusTone;
  items: Opportunity[];
  onCardClick: (opp: Opportunity) => void;
}) {
  return (
    <div className="flex min-w-[280px] max-w-[340px] shrink-0 snap-center flex-col rounded-xl bg-surface-muted/60 p-3 lg:max-w-none">
      <div className="mb-3 flex items-center justify-between px-1">
        <div>
          <h3 className="text-sm font-bold text-ink-900">{title}</h3>
          <p className="text-[11px] text-ink-500">{description}</p>
        </div>
        <StatusBadge tone={tone}>{items.length}</StatusBadge>
      </div>

      <div className="flex flex-1 flex-col gap-3">
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-lg border border-dashed border-line p-6 text-center">
            <p className="text-xs font-medium text-ink-400">Nenhuma</p>
          </div>
        ) : (
          items.map((opp, idx) => {
            const meta = OPPORTUNITY_META[opp.type];
            return (
              <div
                key={`${opp.conversationId}-${opp.type}-${idx}`}
                onClick={() => onCardClick(opp)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && onCardClick(opp)}
                className="group relative flex cursor-pointer flex-col gap-2 rounded-card border border-line bg-white p-3 shadow-sm transition-shadow hover:shadow-e2"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-bold text-ink-900 leading-tight">
                    {opp.contactName ?? opp.contactPhone}
                  </p>
                  <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
                </div>
                <p className="text-xs text-ink-600 line-clamp-2">{opp.label}</p>
                
                <div className="mt-1 flex items-center justify-between border-t border-line/50 pt-2">
                  <p className="text-[10px] font-medium text-ink-400">
                    {new Date(opp.detectedAt).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </p>
                  <span className="flex shrink-0 items-center gap-1 text-[11px] font-bold text-primary group-hover:underline">
                    Atender
                    <ArrowRight className="h-3 w-3" />
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
