"use client";
// Visão geral: panorama do estado da conta. Só mostra dado real (nada de
// métrica inventada) — o que ainda não existe como API fica com estado
// "em breve" (ver componente ComingSoonCard), nunca número fake.
import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarDays, MessageCircle, MessageCircleOff, BookOpen, Settings, ArrowRight, Sparkles } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { ESTABLISHMENT_TYPE_LABELS } from "@/components/lib/labels";
import type { Appointment, Establishment, KnowledgeBase } from "@/types";

interface DashboardData {
  establishment: Establishment;
  whatsappConnected: boolean;
  todayAppointments: Appointment[];
  knowledge: KnowledgeBase | null;
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
    ])
      .then(([est, wa, appts, kb]) => {
        setData({
          establishment: est.establishment,
          whatsappConnected: Boolean(wa.connected),
          todayAppointments: (appts.appointments ?? []).sort(
            (a: Appointment, b: Appointment) => a.startAt - b.startAt,
          ),
          knowledge: kb.knowledge ?? null,
        });
      })
      .catch(() => setError(true));
  }, []);

  if (error) return <ErrorState onRetry={() => window.location.reload()} />;
  if (!data) return <LoadingState />;

  const { establishment, whatsappConnected, todayAppointments, knowledge } = data;
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

      <ComingSoonCard />
    </div>
  );
}

// Espaço reservado para métricas que ainda não têm API real (conversas,
// atendimentos por semana). Nunca mostrar número inventado — só o estado
// "em breve" até existir um endpoint de verdade.
function ComingSoonCard() {
  return (
    <Card className="mt-4 border-dashed bg-transparent">
      <div className="flex items-center gap-3 text-ink-400">
        <Sparkles className="h-5 w-5" />
        <p className="text-sm">
          Em breve: conversas recentes e métricas de atendimento da Livia aqui.
        </p>
      </div>
    </Card>
  );
}
