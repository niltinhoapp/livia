"use client";
// Visão geral: panorama do estado da conta. Só mostra dado real (nada de
// métrica inventada) — o que ainda não existe como API fica com estado
// "em breve" (ver componente ComingSoonCard), nunca número fake.
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  CalendarDays,
  MessageCircle,
  MessageCircleOff,
  BookOpen,
  Settings,
  ArrowRight,
  Sparkles,
  Users,
  UserCheck,
  ListChecks,
} from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { ESTABLISHMENT_TYPE_LABELS, INTENT_LABEL } from "@/components/lib/labels";
import type { Appointment, Establishment, IntentType, KnowledgeBase, Opportunity } from "@/types";
import type { FunnelResult } from "@/lib/ai/funnel";

interface DashboardMetrics {
  funnel: FunnelResult;
  agendamentosCriadosHoje: number;
  cancelamentosHoje: number;
  pendenciasAbertas: number;
  conversasPrecisandoHumano: number;
  intencoesFrequentesHoje: { intent: IntentType; count: number }[];
  oportunidadesAbertas: number;
  oportunidades: Opportunity[];
}

interface DashboardData {
  establishment: Establishment;
  whatsappConnected: boolean;
  todayAppointments: Appointment[];
  knowledge: KnowledgeBase | null;
  metrics: DashboardMetrics | null; // null só se a chamada falhar — nunca métrica inventada no lugar
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const from = startOfDay.getTime();
    const to = from + 24 * 3600000;

    Promise.all([
      fetch("/api/establishment").then((r) => r.json()),
      fetch("/api/whatsapp/connect").then((r) => r.json()),
      fetch(`/api/appointments?from=${from}&to=${to}`).then((r) => r.json()),
      fetch("/api/knowledge").then((r) => r.json()),
      fetch(`/api/dashboard?from=${from}&to=${to}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ])
      .then(([est, wa, appts, kb, metrics]) => {
        setData({
          establishment: est.establishment,
          whatsappConnected: Boolean(wa.connected),
          todayAppointments: (appts.appointments ?? []).sort(
            (a: Appointment, b: Appointment) => a.startAt - b.startAt,
          ),
          knowledge: kb.knowledge ?? null,
          metrics,
        });
      })
      .catch(() => setError(true));
  }, []);

  if (error) return <ErrorState onRetry={() => window.location.reload()} />;
  if (!data) return <LoadingState />;

  const { establishment, whatsappConnected, todayAppointments, knowledge, metrics } = data;
  const activeToday = todayAppointments.filter((a) => a.status !== "cancelled");
  const knowledgeComplete = Boolean(knowledge?.about && (knowledge?.services?.length ?? 0) > 0);

  return (
    <div className="mx-auto max-w-5xl">
      <p className="mb-1 text-sm font-semibold text-primary">Olá 👋</p>
      <h1 className="mb-1 text-2xl font-bold text-ink-900">
        {establishment.name || "Bem-vindo(a) à Livia"}
      </h1>
      <p className="mb-8 text-sm text-ink-500">
        {establishment.name ? ESTABLISHMENT_TYPE_LABELS[establishment.type] : "Vamos configurar seu atendimento."}
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">WhatsApp</p>
              <p className="mt-1 text-lg font-bold text-ink-900">
                {whatsappConnected ? "Conectado" : "Não conectado"}
              </p>
            </div>
            <div className={`rounded-full p-2 ${whatsappConnected ? "bg-success-bg text-success-fg" : "bg-warning-bg text-warning-fg"}`}>
              {whatsappConnected ? <MessageCircle className="h-5 w-5" /> : <MessageCircleOff className="h-5 w-5" />}
            </div>
          </div>
          <Link href="/painel/whatsapp" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            {whatsappConnected ? "Ver conexão" : "Conectar agora"} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>

        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">Agendamentos hoje</p>
              <p className="mt-1 text-lg font-bold text-ink-900">{activeToday.length}</p>
            </div>
            <div className="rounded-full bg-info-bg p-2 text-info-fg">
              <CalendarDays className="h-5 w-5" />
            </div>
          </div>
          <Link href="/painel/agenda" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            Ver agenda <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">Base de conhecimento</p>
              <p className="mt-1 text-lg font-bold text-ink-900">{knowledgeComplete ? "Configurada" : "Incompleta"}</p>
            </div>
            <div className={`rounded-full p-2 ${knowledgeComplete ? "bg-success-bg text-success-fg" : "bg-warning-bg text-warning-fg"}`}>
              <BookOpen className="h-5 w-5" />
            </div>
          </div>
          <Link href="/painel/conhecimento" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            {knowledgeComplete ? "Editar" : "Completar agora"} <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>

        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">Agendamento pela IA</p>
              <p className="mt-1 text-lg font-bold text-ink-900">
                {establishment.bot?.bookingEnabled ? "Ativado" : "Desativado"}
              </p>
            </div>
            <div className="rounded-full bg-line/60 p-2 text-ink-500">
              <Settings className="h-5 w-5" />
            </div>
          </div>
          <Link href="/painel/configuracoes" className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            Ajustar <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>
      </div>

      <Card className="mt-4">
        <div className="mb-4 flex items-center justify-between">
          <CardTitle>Próximos agendamentos de hoje</CardTitle>
          <Link href="/painel/agenda">
            <Button variant="secondary" size="sm">
              Ver tudo
            </Button>
          </Link>
        </div>
        {activeToday.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">Nenhum agendamento para hoje.</p>
        ) : (
          <div className="divide-y divide-line">
            {activeToday.slice(0, 5).map((a) => (
              <div key={a.id} className="flex items-center justify-between py-3">
                <div>
                  <p className="text-sm font-semibold text-ink-900">{a.serviceName}</p>
                  <p className="text-xs text-ink-500">{a.contactName ?? "Cliente"}</p>
                </div>
                <StatusBadge tone={a.status === "confirmed" ? "success" : a.status === "pending" ? "warning" : "neutral"}>
                  {new Date(a.startAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                </StatusBadge>
              </div>
            ))}
          </div>
        )}
      </Card>

      {metrics ? <DailyPanel metrics={metrics} /> : <ComingSoonCard />}
    </div>
  );
}

// Passo 13 — painel diário. Só renderiza quando GET /api/dashboard respondeu
// com sucesso (metrics !== null) — se falhar, cai no card "em breve" abaixo
// em vez de mostrar zero/erro disfarçado de dado real.
function DailyPanel({ metrics }: { metrics: DashboardMetrics }) {
  const { funnel } = metrics;
  return (
    <>
      {/* Passo 12 — funil do dia. Cada etapa é uma contagem real; a taxa só
          aparece quando há denominador (nunca 0% enganoso). */}
      <Card className="mt-4">
        <CardTitle>Funil de hoje</CardTitle>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
        {/* O funil conta CONVERSAS em todas as etapas; este é o número
            operacional de agendamentos criados, que pode ser maior quando o
            mesmo cliente agenda mais de uma vez no dia. */}
        <p className="mt-1 text-xs text-ink-400">
          Agendamentos criados hoje: <span className="font-semibold text-ink-700">{metrics.agendamentosCriadosHoje}</span>
        </p>
      </Card>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">Cancelamentos hoje</p>
              <p className="mt-1 text-lg font-bold text-ink-900">{metrics.cancelamentosHoje}</p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">Pendências abertas</p>
              <p className="mt-1 text-lg font-bold text-ink-900">{metrics.pendenciasAbertas}</p>
            </div>
            <div className="rounded-full bg-warning-bg p-2 text-warning-fg">
              <ListChecks className="h-5 w-5" />
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-ink-500">Precisam de você</p>
              <p className="mt-1 text-lg font-bold text-ink-900">{metrics.conversasPrecisandoHumano}</p>
            </div>
            <div className="rounded-full bg-danger-bg p-2 text-danger-fg">
              <UserCheck className="h-5 w-5" />
            </div>
          </div>
          <Link href="/painel/conversas" className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
            Ver conversas <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Card>
      </div>

      {/* "A Livia encontrou oportunidades" */}
      <Card className="mt-4">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <CardTitle>A Livia encontrou oportunidades</CardTitle>
          </div>
          {metrics.oportunidadesAbertas > 0 && (
            <StatusBadge tone="info">{metrics.oportunidadesAbertas}</StatusBadge>
          )}
        </div>
        {metrics.oportunidades.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-400">Nenhuma oportunidade aberta agora.</p>
        ) : (
          <div className="divide-y divide-line">
            {metrics.oportunidades.map((o) => (
              <Link
                key={`${o.type}-${o.conversationId}`}
                href={`/painel/conversas?conversa=${o.conversationId}`}
                className="flex items-center justify-between gap-2 py-2.5 hover:bg-line/10"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-ink-900">{o.contactName ?? o.contactPhone}</p>
                  <p className="text-xs text-ink-500">{o.label}</p>
                </div>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-ink-400" />
              </Link>
            ))}
          </div>
        )}
      </Card>

      {metrics.intencoesFrequentesHoje.length > 0 && (
        <Card className="mt-4">
          <CardTitle>Intenções mais frequentes hoje</CardTitle>
          <div className="mt-3 flex flex-wrap gap-2">
            {metrics.intencoesFrequentesHoje.map((i) => (
              <span key={i.intent} className="rounded-full bg-line/40 px-3 py-1 text-xs font-semibold text-ink-700">
                {INTENT_LABEL[i.intent] ?? i.intent} · {i.count}
              </span>
            ))}
          </div>
        </Card>
      )}

      <Card className="mt-4">
        <Link href="/painel/clientes" className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <p className="text-sm font-semibold text-ink-900">Ver clientes (CRM)</p>
          </div>
          <ArrowRight className="h-3.5 w-3.5 text-ink-400" />
        </Link>
      </Card>
    </>
  );
}

function FunnelStep({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-control border border-line p-3 text-center">
      <p className={`text-xl font-bold ${tone ?? "text-ink-900"}`}>{value}</p>
      <p className="mt-0.5 text-xs text-ink-500">{label}</p>
    </div>
  );
}

// Espaço reservado pra quando GET /api/dashboard não responder (nunca
// mostrar número inventado no lugar de um endpoint que falhou).
function ComingSoonCard() {
  return (
    <Card className="mt-4 border-dashed bg-transparent">
      <div className="flex items-center gap-3 text-ink-400">
        <Sparkles className="h-5 w-5" />
        <p className="text-sm">
          Não foi possível carregar as métricas de hoje agora. Tente atualizar a página.
        </p>
      </div>
    </Card>
  );
}
