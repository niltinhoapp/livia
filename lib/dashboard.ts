// Camada de orquestração dos Passos 10-13 (README.md/Plano Mestre): CRM,
// caixa de entrada, oportunidades/funil e painel diário.
//
// Este arquivo só FAZ QUERIES e chama funções puras (lib/ai/opportunities.ts,
// lib/ai/inbox.ts, lib/ai/funnel.ts) — nenhuma regra de classificação mora
// aqui, pra manter a lógica testável sem Firestore. Toda query é de campo
// único (range OU igualdade, nunca combinadas), limitada, e reaproveitada
// entre métricas sempre que possível — ver o comentário de cada função pro
// motivo de cada escolha.
import {
  listPendingTasks,
  listConversationsSince,
  listCustomerProfiles,
  getCustomerProfile,
  getConversation,
  getPendingTask,
} from "@/lib/repo";
import {
  listAppointments,
  listAppointmentsCreatedSince,
  listAppointmentsCancelledSince,
} from "@/lib/scheduling";
import { opportunitiesFromPendingTasks, priceInquiryOpportunities, cancelledNoRebookingOpportunities } from "@/lib/ai/opportunities";
import { classifyConversation } from "@/lib/ai/inbox";
import { computeDailyFunnel, type FunnelResult } from "@/lib/ai/funnel";
import { normalizePhone } from "@/lib/whatsapp/client";
import type { Conversation, CustomerProfile, InboxCategory, IntentType, Opportunity, PendingTask } from "@/types";

const THIRTY_DAYS_MS = 30 * 24 * 3600000;
const NINETY_DAYS_MS = 90 * 24 * 3600000;

// ---- Passo 12 — Oportunidades ----
//
// Custo: 4 queries fixas, cada uma limitada (não escala com o total de
// dados do tenant) — nunca N+1. `upcoming` é buscado UMA vez e vira o Set de
// telefones com agendamento ativo, reaproveitado pelas duas checagens que
// precisam disso (preço sem agendar, cancelou sem remarcar).
//
// `preloadedPendingTasks` é opcional: quem já buscou a lista de pendências
// pra outro motivo na mesma requisição (ex.: classifyConversationsForInbox)
// passa ela aqui pra não repetir a mesma query duas vezes.
export async function getOpportunities(
  establishmentId: string,
  preloadedPendingTasks?: PendingTask[],
): Promise<Opportunity[]> {
  const since30d = Date.now() - THIRTY_DAYS_MS;

  // 900 = mesma densidade das janelas de 30 dias já usadas ao lado (300
  // conversas / 200 cancelamentos) escalada pra 90 dias (3x). Este consumidor
  // só usa o resultado pra montar um Set de "telefones com algo marcado" —
  // não precisa do agendamento exato, só saber que existe; truncar mantém os
  // mais próximos (listAppointments ordena por startAt asc), que são os
  // únicos que decidem essa checagem no curto/médio prazo.
  const UPCOMING_APPOINTMENTS_LIMIT = 900;

  const [pendingTasks, recentConversations, cancelledRecently, upcoming] = await Promise.all([
    preloadedPendingTasks ? Promise.resolve(preloadedPendingTasks) : listPendingTasks(establishmentId),
    listConversationsSince(establishmentId, since30d, 300),
    listAppointmentsCancelledSince(establishmentId, since30d, 200),
    listAppointments(establishmentId, Date.now(), Date.now() + NINETY_DAYS_MS, UPCOMING_APPOINTMENTS_LIMIT),
  ]);

  const nameByConversationId = new Map<string, string | null>(recentConversations.map((c) => [c.id, c.contactName]));
  const activePhones = new Set(
    upcoming.filter((a) => a.status === "pending" || a.status === "confirmed").map((a) => normalizePhone(a.contactPhone)),
  );
  const hasActiveAppointment = (phone: string) => activePhones.has(normalizePhone(phone));

  return [
    ...opportunitiesFromPendingTasks(pendingTasks, nameByConversationId),
    ...priceInquiryOpportunities(recentConversations, hasActiveAppointment),
    ...cancelledNoRebookingOpportunities(cancelledRecently, hasActiveAppointment),
  ];
}

// ---- Passo 11 — Caixa de entrada ----
//
// GET /api/conversations chama isto a cada poll de 15s de /painel/conversas
// (LIST_REFRESH_MS) — é o caminho mais quente do produto. Por isso, desde a
// auditoria de 03/09 (50 mil reads/dia), esta função NÃO calcula mais
// oportunidades: fazia isso a cada poll, repetindo as 4 queries pesadas de
// getOpportunities (30 dias de conversas, 30 dias de cancelamentos, 90 dias
// de agendamentos futuros) 4 vezes por minuto, mesmo quando nada mudou.
//
// Só listPendingTasks roda aqui — 1 query, já necessária pras categorias
// needs_human/complaint/customer_waiting/appointment_incomplete. A categoria
// "opportunity" (que depende de getOpportunities) é responsabilidade do
// FRONTEND: busca GET /api/opportunities uma vez, num intervalo bem mais
// longo, e faz o merge client-side com classifyConversation's hasOpportunity
// — ver app/painel/conversas/page.tsx e lib/ai/inbox.ts:
// applyOpportunityOverride. A prioridade das categorias continua a mesma
// (opportunity só vence "resolved"), só o CÁLCULO saiu do caminho quente.
export interface InboxConversation extends Conversation {
  inboxCategory: InboxCategory;
}

export async function classifyConversationsForInbox(
  establishmentId: string,
  conversations: Conversation[],
): Promise<InboxConversation[]> {
  const pendingTasks = await listPendingTasks(establishmentId);
  const pendingByConversation = new Map(pendingTasks.map((pt) => [pt.conversationId, pt.type]));

  return conversations.map((c) => ({
    ...c,
    inboxCategory: classifyConversation({
      status: c.status,
      pendingTaskType: pendingByConversation.get(c.id),
      hasOpportunity: false,
    }),
  }));
}

// ---- Passo 10 — CRM ----
//
// Lista: só CustomerProfile, sem junções (evita N+1 ao carregar muitos
// clientes de uma vez). Detalhe de UM cliente: 3 leituras por id (perfil,
// conversa, pendência) — aceitável por ser sob demanda, não em lote.
export interface CustomerDetail {
  profile: CustomerProfile;
  // Resumo/contexto e pendência atual são derivados de Conversation e
  // PendingTask — NUNCA copiados para dentro de CustomerProfile, pra não
  // duplicar a fonte de verdade de cada um.
  conversationSummary: string | null;
  conversationId: string | null;
  pendingTask: PendingTask | null;
  // "ativo" = interagiu nos últimos 7 dias; "recente" = até 30 dias; "inativo"
  // = mais que isso. Cálculo determinístico só sobre lastInteractionAt —
  // nunca uma inferência de humor/satisfação.
  relationshipStatus: "active" | "recent" | "inactive";
}

export async function listCustomers(establishmentId: string): Promise<CustomerProfile[]> {
  return listCustomerProfiles(establishmentId);
}

export async function getCustomerDetail(establishmentId: string, phone: string): Promise<CustomerDetail | null> {
  const profile = await getCustomerProfile(establishmentId, phone);
  if (!profile) return null;

  const conversationId = normalizePhone(phone);
  const [conversation, pendingTask] = await Promise.all([
    getConversation(establishmentId, conversationId),
    getPendingTask(establishmentId, conversationId),
  ]);

  return {
    profile,
    conversationSummary: conversation?.summary ?? null,
    conversationId: conversation?.id ?? null,
    pendingTask: pendingTask?.status === "open" ? pendingTask : null,
    relationshipStatus: relationshipStatusOf(profile.lastInteractionAt),
  };
}

function relationshipStatusOf(lastInteractionAt: number): "active" | "recent" | "inactive" {
  const days = (Date.now() - lastInteractionAt) / (24 * 3600000);
  if (days <= 7) return "active";
  if (days <= 30) return "recent";
  return "inactive";
}

// ---- Passo 13 — Painel diário ----
//
// `todayStart`/`todayEnd` vêm de quem chama (a rota da API), calculados no
// NAVEGADOR do dono — o mesmo padrão já usado por
// GET /api/appointments?from=&to= (app/painel/page.tsx). Calcular o "hoje"
// no servidor usaria o fuso do processo (UTC na Vercel), que erraria a
// virada do dia pra quem está no Brasil.
export interface DashboardMetrics {
  funnel: FunnelResult;
  agendamentosCriadosHoje: number;
  cancelamentosHoje: number;
  pendenciasAbertas: number;
  conversasPrecisandoHumano: number;
  intencoesFrequentesHoje: { intent: IntentType; count: number }[];
  oportunidadesAbertas: number;
  oportunidades: Opportunity[]; // mais recentes primeiro, já limitado pra exibição
}

export async function getDashboardMetrics(
  establishmentId: string,
  todayStart: number,
  todayEnd: number,
): Promise<DashboardMetrics> {
  // pendingTasks é buscado antes e passado pra getOpportunities — evita
  // repetir a mesma query (ver getOpportunities: `preloadedPendingTasks`).
  const pendingTasks = await listPendingTasks(establishmentId, 200);
  const [todayConvos, createdToday, cancelledToday, opportunities] = await Promise.all([
    listConversationsSince(establishmentId, todayStart, 500),
    listAppointmentsCreatedSince(establishmentId, todayStart, 500),
    listAppointmentsCancelledSince(establishmentId, todayStart, 500),
    getOpportunities(establishmentId, pendingTasks),
  ]);

  // `listConversationsSince` só tem limite inferior — descarta o que passou
  // de `todayEnd` (relevante se a rota for chamada com um intervalo que não
  // seja "hoje até agora").
  const scopedConvos = todayConvos.filter((c) => c.lastMessageAt < todayEnd);
  const scopedCreated = createdToday.filter((a) => a.createdAt < todayEnd);
  const scopedCancelled = cancelledToday.filter((a) => (a.cancelledAt ?? 0) < todayEnd);

  // Agendamentos criados pelo BOT no período. Não filtra por status de
  // propósito: o compromisso pode continuar "pending" (aguardando
  // confirmação) na agenda e a conversão comercial já aconteceu no momento em
  // que create_appointment devolveu sucesso e o Appointment foi persistido.
  // Agendamentos "manual" (digitados pelo dono no painel) ficam de fora — o
  // funil aqui é o das conversas. Agendamentos de outros dias também não
  // entram: o filtro é por `createdAt` dentro do período.
  const agendamentosDoBot = scopedCreated.filter((a) => a.source === "bot");

  // O funil correlaciona cada agendamento à conversa que o originou (pelo
  // telefone) e conta CONVERSAS em todas as etapas — ver computeDailyFunnel.
  const funnel = computeDailyFunnel({
    conversations: scopedConvos.map((c) => ({
      contactPhoneKey: normalizePhone(c.contactPhone),
      lastIntent: c.lastIntent,
      lastScheduleIntentAt: c.lastScheduleIntentAt,
    })),
    botAppointmentPhoneKeys: agendamentosDoBot.map((a) => normalizePhone(a.contactPhone)),
    from: todayStart,
    to: todayEnd,
  });

  const intentCounts = new Map<IntentType, number>();
  for (const c of scopedConvos) {
    if (!c.lastIntent) continue;
    intentCounts.set(c.lastIntent, (intentCounts.get(c.lastIntent) ?? 0) + 1);
  }
  const intencoesFrequentesHoje = [...intentCounts.entries()]
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  return {
    funnel,
    agendamentosCriadosHoje: scopedCreated.length,
    cancelamentosHoje: scopedCancelled.length,
    pendenciasAbertas: pendingTasks.length,
    conversasPrecisandoHumano: pendingTasks.filter((pt) => pt.type === "awaiting_human").length,
    intencoesFrequentesHoje,
    oportunidadesAbertas: opportunities.length,
    oportunidades: [...opportunities].sort((a, b) => b.detectedAt - a.detectedAt).slice(0, 5),
  };
}
