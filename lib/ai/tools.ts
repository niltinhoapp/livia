// Camada de ferramentas internas — Passo 6 do README.md/Plano Mestre.
//
// Interface única: IA decide QUAL ferramenta chamar e COM QUAIS argumentos;
// esta camada é a única autoridade sobre validação e execução. O resultado
// que volta pra IA (`ToolResult`) é sempre o que o backend realmente fez —
// nunca o texto da IA é tratado como prova de que uma operação aconteceu.
// `lib/ai/brain.ts` só decide QUANDO chamar o loop de ferramentas; toda a
// lógica de negócio mora aqui, reaproveitando os motores existentes
// (lib/scheduling.ts, lib/repo.ts) — nada é reimplementado.
import type OpenAI from "openai";
import type { Appointment, Establishment, ScheduleConfig, KnowledgeBase, CustomerProfile } from "@/types";
import {
  listAppointments,
  listCustomerAppointments,
  getAppointment,
  computeSlots,
  createAppointment,
  localToEpoch,
  hasScheduleConflict,
  findNextAppointment,
  updateAppointment,
  setStatus,
  weekdayOf,
  getScheduleConfig,
} from "@/lib/scheduling";
import { getCustomerProfile, upsertCustomerProfile } from "@/lib/repo";
import { normalizePhone } from "@/lib/whatsapp/client";

export interface ToolContext {
  est: Establishment;
  kb: KnowledgeBase | null;
  config: ScheduleConfig | null; // null quando bot.bookingEnabled é false
  contactPhone: string;
  contactName: string | null;
  offset: number; // utcOffsetMinutes efetivo (config, ou -180 sem config)
  customerProfile: CustomerProfile | null;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ToolDefinition {
  name: string;
  // Algumas ferramentas exigem a agenda configurada (bookingEnabled) —
  // outras (perguntar horário, buscar na base, pedir humano, ler/atualizar
  // preferência do cliente) fazem sentido sempre, mesmo sem booking.
  enabled: (ctx: ToolContext) => boolean;
  schema: OpenAI.Chat.ChatCompletionTool;
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

function fn(
  name: string,
  description: string,
  parameters: OpenAI.FunctionParameters,
): OpenAI.Chat.ChatCompletionTool {
  return { type: "function", function: { name, description, parameters } };
}

// ---- getBusinessHours ----
// Reaproveita o motor de agenda (lib/scheduling.ts) — não duplica a lógica
// de dias/pausas que já existe para o cálculo de horários livres. Disponível
// mesmo sem booking habilitado: saber se abre num dia é uma pergunta válida
// independente de a Livia poder agendar.
const getBusinessHours: ToolDefinition = {
  name: "get_business_hours",
  enabled: () => true,
  schema: fn(
    "get_business_hours",
    "Retorna o horário de funcionamento REAL de um dia específico (aberto/fechado, horário, pausas). Use antes de afirmar se o estabelecimento está aberto em algum dia.",
    {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD. Se omitido, usa hoje." },
      },
    },
  ),
  async execute(ctx, args) {
    const date =
      typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date)
        ? args.date
        : new Date(Date.now() + ctx.offset * 60000).toISOString().slice(0, 10);
    // Config sempre existe (getScheduleConfig tem default) — mas só a
    // carregamos aqui se o chamador não tinha booking habilitado (ctx.config
    // null), evitando o custo quando já foi carregada.
    const config = ctx.config ?? (await getScheduleConfig(ctx.est.id));
    const day = config.days[String(weekdayOf(date))];
    if (!day) return { ok: true, data: { date, open: false } };
    return { ok: true, data: { date, open: true, opensAt: day.open, closesAt: day.close, breaks: day.breaks ?? [] } };
  },
};

// ---- searchKnowledgeBase ----
// A base de conhecimento inteira já entra no prompt (lib/ai/brain.ts:
// knowledgeToText) — esta ferramenta não existe pra reduzir tokens, existe
// pra dar uma resposta ESTRUTURADA (e citável) quando a IA precisa apontar
// exatamente de onde tirou um preço/serviço/FAQ, em vez de reformular o bloco
// de texto livre. Busca determinística (substring), sem custo de IA.
const searchKnowledgeBase: ToolDefinition = {
  name: "search_knowledge_base",
  enabled: () => true,
  schema: fn(
    "search_knowledge_base",
    "Busca na base de conhecimento cadastrada (serviços, FAQs, observações) por um termo. Use para confirmar um dado específico antes de afirmá-lo.",
    {
      type: "object",
      properties: { query: { type: "string", description: "Termo de busca, ex.: nome de um serviço" } },
      required: ["query"],
    },
  ),
  async execute(ctx, args) {
    const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    if (!query) return { ok: false, error: "query vazia" };
    if (!ctx.kb) return { ok: true, data: { matches: [], note: "Nenhuma base de conhecimento cadastrada." } };

    const matches: { source: string; text: string }[] = [];
    for (const s of ctx.kb.services ?? []) {
      const hay = `${s.name} ${s.description ?? ""}`.toLowerCase();
      if (hay.includes(query)) {
        matches.push({
          source: "service",
          text: [s.name, s.priceText ? `preço: ${s.priceText}` : null, s.durationText ? `duração: ${s.durationText}` : null]
            .filter(Boolean)
            .join(" | "),
        });
      }
    }
    for (const f of ctx.kb.faqs ?? []) {
      if (`${f.question} ${f.answer}`.toLowerCase().includes(query)) {
        matches.push({ source: "faq", text: `P: ${f.question}\nR: ${f.answer}` });
      }
    }
    if (ctx.kb.notes?.toLowerCase().includes(query)) {
      matches.push({ source: "notes", text: ctx.kb.notes });
    }
    return { ok: true, data: { matches: matches.slice(0, 5) } };
  },
};

// ---- getCustomerProfile / updateCustomerProfile ----
// O perfil já é injetado no prompt como fonte de verdade (Pacote 1); esta
// ferramenta existe pra IA poder reconsultar sob demanda (ex.: depois de uma
// chamada a update_customer_profile, na mesma rodada) sem depender de reler
// o prompt inteiro.
const getCustomerProfileTool: ToolDefinition = {
  name: "get_customer_profile",
  enabled: () => true,
  schema: fn("get_customer_profile", "Retorna o perfil salvo deste cliente (preferências já conhecidas).", {
    type: "object",
    properties: {},
  }),
  async execute(ctx) {
    const profile = ctx.customerProfile ?? (await getCustomerProfile(ctx.est.id, ctx.contactPhone));
    return { ok: true, data: profile ?? null };
  },
};

// Campos permitidos aqui são SÓ preferências que o próprio cliente relata na
// conversa (profissional/horário preferido, endereço frequente) — nunca
// nome, lastService ou lastIntent, que são escritos exclusivamente com dado
// determinístico pelo webhook (ver app/api/webhooks/whatsapp/route.ts).
// Deixar a IA escrever esses três abriria exatamente a brecha que o Pacote 1
// fechou: uma inferência da IA virando "fato confiável" no perfil.
const updateCustomerProfile: ToolDefinition = {
  name: "update_customer_profile",
  enabled: () => true,
  schema: fn(
    "update_customer_profile",
    "Salva uma preferência que o cliente relatou agora (profissional preferido, horário preferido ou endereço frequente). Só use quando o cliente disser isso explicitamente.",
    {
      type: "object",
      properties: {
        preferredProfessional: { type: "string" },
        preferredTime: { type: "string" },
        frequentAddress: { type: "string" },
      },
    },
  ),
  async execute(ctx, args) {
    const patch: Parameters<typeof upsertCustomerProfile>[2] = {};
    if (typeof args.preferredProfessional === "string") patch.preferredProfessional = args.preferredProfessional;
    if (typeof args.preferredTime === "string") patch.preferredTime = args.preferredTime;
    if (typeof args.frequentAddress === "string") patch.frequentAddress = args.frequentAddress;
    if (Object.keys(patch).length === 0) return { ok: false, error: "nenhum campo válido informado" };
    await upsertCustomerProfile(ctx.est.id, ctx.contactPhone, patch);
    return { ok: true, data: patch };
  },
};

// ---- findAvailableAppointments (agenda real) ----
const findAvailableAppointments: ToolDefinition = {
  name: "find_available_appointments",
  enabled: (ctx) => ctx.est.bot.bookingEnabled,
  schema: fn(
    "find_available_appointments",
    "Retorna os horários livres REAIS de um dia. Use antes de oferecer qualquer horário — nunca chute.",
    {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD" },
        durationMin: { type: "number", description: "Duração em minutos (opcional; usa o padrão do estabelecimento)" },
      },
      required: ["date"],
    },
  ),
  async execute(ctx, args) {
    const date = args.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false, error: "date inválida (use YYYY-MM-DD)" };
    }
    const config = ctx.config!;
    const duration = typeof args.durationMin === "number" ? args.durationMin : config.defaultDurationMin;
    const dayStart = localToEpoch(date, 0, config.utcOffsetMinutes);
    const existing = await listAppointments(ctx.est.id, dayStart, dayStart + 24 * 3600000);
    const slots = computeSlots(config, date, duration, existing).slice(0, 12);
    if (slots.length === 0) return { ok: true, data: { date, slots: [], note: "Sem horários livres neste dia." } };
    return { ok: true, data: { date, slots } };
  },
};

// ---- createAppointment ----
const createAppointmentTool: ToolDefinition = {
  name: "create_appointment",
  enabled: (ctx) => ctx.est.bot.bookingEnabled,
  schema: fn("create_appointment", "Cria o agendamento após o cliente escolher e confirmar um horário.", {
    type: "object",
    properties: {
      serviceName: { type: "string" },
      startAt: { type: "number", description: "epoch em ms de um horário retornado por find_available_appointments" },
      durationMin: { type: "number" },
      contactName: { type: "string", description: "nome do cliente, se souber" },
    },
    required: ["serviceName", "startAt"],
  }),
  async execute(ctx, args) {
    if (typeof args.serviceName !== "string" || typeof args.startAt !== "number") {
      return { ok: false, error: "serviceName e startAt são obrigatórios" };
    }
    const config = ctx.config!;
    const duration = typeof args.durationMin === "number" ? args.durationMin : config.defaultDurationMin;

    if (await hasScheduleConflict(ctx.est.id, args.startAt, duration)) {
      return { ok: false, error: "esse horário acabou de ser ocupado; ofereça outro" };
    }

    await createAppointment(ctx.est.id, {
      contactPhone: ctx.contactPhone,
      contactName: typeof args.contactName === "string" ? args.contactName : ctx.contactName,
      serviceName: args.serviceName,
      startAt: args.startAt,
      durationMin: duration,
      source: "bot",
    });
    return { ok: true, data: { when: formatWhen(args.startAt, ctx.offset), serviceName: args.serviceName } };
  },
};

// ---- getCustomerAppointments ----
// A agenda é a FONTE DE VERDADE sobre o que o cliente tem marcado. Sem esta
// ferramenta a Livia não tinha como consultar um agendamento existente: a
// única leitura de agenda exposta era find_available_appointments, que
// devolve horários LIVRES — foi exatamente por isso que ela respondeu "não
// consegui agendar, veja estes horários" para um cliente que já tinha
// consulta marcada.
//
// As datas são resolvidas AQUI (com o offset do estabelecimento) e entregues
// já rotuladas como "hoje"/"amanhã"/data concreta. O modelo não decide qual
// agendamento é "hoje".
const getCustomerAppointments: ToolDefinition = {
  name: "get_customer_appointments",
  enabled: () => true,
  schema: fn(
    "get_customer_appointments",
    "Retorna os agendamentos REAIS deste cliente na agenda. Use SEMPRE que ele perguntar sobre um horário já marcado (ex.: 'confirma minha consulta', 'tenho consulta hoje?', 'qual horário marquei?', 'você marcou?') — nunca responda isso de memória.",
    {
      type: "object",
      properties: {
        includePast: {
          type: "boolean",
          description: "Incluir agendamentos que já passaram hoje (padrão: true, começa no início do dia de hoje).",
        },
      },
    },
  ),
  async execute(ctx, args) {
    const config = ctx.config ?? (await getScheduleConfig(ctx.est.id));
    const offset = config.utcOffsetMinutes;
    // Início do dia LOCAL de hoje — assim uma consulta às 09:00 continua
    // aparecendo quando o cliente pergunta às 14:00.
    const from = args.includePast === false ? Date.now() : startOfLocalDay(Date.now(), offset);

    const appointments = await listCustomerAppointments(ctx.est.id, normalizePhone(ctx.contactPhone), from);
    const active = appointments.filter((a) => a.status !== "cancelled" && a.status !== "no_show");

    if (active.length === 0) {
      return {
        ok: true,
        data: { appointments: [], note: "Este cliente não tem nenhum agendamento ativo a partir de hoje." },
      };
    }

    return {
      ok: true,
      data: {
        today: localDateString(Date.now(), offset),
        appointments: active.map((a) => ({
          id: a.id,
          serviceName: a.serviceName,
          date: localDateString(a.startAt, offset),
          time: localTimeString(a.startAt, offset),
          // Rótulo relativo calculado pelo backend — o modelo não infere.
          day: relativeDayLabel(a.startAt, offset),
          durationMin: a.durationMin,
          // "pending" = reservado, aguardando o cliente confirmar presença.
          // "confirmed" = presença já confirmada. NUNCA tratar pending como
          // inexistente: o horário ESTÁ reservado.
          status: a.status,
          statusMeaning:
            a.status === "pending"
              ? "horário reservado, aguardando confirmação do cliente"
              : a.status === "confirmed"
                ? "presença confirmada pelo cliente"
                : a.status,
          source: a.source,
        })),
      },
    };
  },
};

// ---- confirmAppointment ----
// Única forma de levar um agendamento de "pending" para "confirmed".
// Reaproveita setStatus (lib/scheduling.ts) — nenhum motor novo. O status só
// muda se esta ferramenta devolver sucesso; texto da IA nunca confirma nada.
const confirmAppointment: ToolDefinition = {
  name: "confirm_appointment",
  enabled: (ctx) => ctx.est.bot.bookingEnabled,
  schema: fn(
    "confirm_appointment",
    "Confirma a PRESENÇA do cliente num agendamento que está aguardando confirmação. Use apenas quando ele disser explicitamente que vai comparecer (ex.: 'confirmo', 'sim, vou estar lá').",
    {
      type: "object",
      properties: {
        appointmentId: {
          type: "string",
          description: "id vindo de get_customer_appointments. Se omitido, confirma o próximo agendamento ativo.",
        },
      },
    },
  ),
  async execute(ctx, args) {
    const config = ctx.config ?? (await getScheduleConfig(ctx.est.id));
    const phone = normalizePhone(ctx.contactPhone);

    let target: Appointment | null = null;
    if (typeof args.appointmentId === "string" && args.appointmentId) {
      const found = await getAppointment(ctx.est.id, args.appointmentId);
      // Trava de segurança: só confirma agendamento DESTE contato — um id
      // vindo do modelo nunca pode alcançar o agendamento de outra pessoa.
      if (found && normalizePhone(found.contactPhone) === phone) target = found;
    } else {
      target = await findNextAppointment(ctx.est.id, phone);
    }

    if (!target) return { ok: false, error: "nenhum agendamento ativo encontrado para confirmar" };
    if (target.status === "confirmed") {
      return {
        ok: true,
        data: { alreadyConfirmed: true, when: formatWhen(target.startAt, config.utcOffsetMinutes), serviceName: target.serviceName },
      };
    }
    if (target.status !== "pending") {
      return { ok: false, error: `agendamento com status "${target.status}" não pode ser confirmado` };
    }

    await setStatus(ctx.est.id, target.id, "confirmed");
    return {
      ok: true,
      data: {
        confirmed: true,
        when: formatWhen(target.startAt, config.utcOffsetMinutes),
        day: relativeDayLabel(target.startAt, config.utcOffsetMinutes),
        serviceName: target.serviceName,
      },
    };
  },
};

// ---- rescheduleAppointment ----
// Opera sobre o PRÓXIMO agendamento ativo do cliente (mesma noção já usada
// pelo fluxo de confirmação de lembrete no webhook) — a IA não maneja IDs de
// agendamento diretamente.
const rescheduleAppointment: ToolDefinition = {
  name: "reschedule_appointment",
  enabled: (ctx) => ctx.est.bot.bookingEnabled,
  schema: fn(
    "reschedule_appointment",
    "Remarca o próximo agendamento ativo do cliente para um novo horário. Use find_available_appointments antes para confirmar que o novo horário está livre.",
    {
      type: "object",
      properties: {
        newStartAt: { type: "number", description: "epoch em ms do novo horário, vindo de find_available_appointments" },
        newDurationMin: { type: "number" },
      },
      required: ["newStartAt"],
    },
  ),
  async execute(ctx, args) {
    if (typeof args.newStartAt !== "number") return { ok: false, error: "newStartAt é obrigatório" };
    const appt = await findNextAppointment(ctx.est.id, normalizePhone(ctx.contactPhone));
    if (!appt) return { ok: false, error: "nenhum agendamento ativo encontrado para remarcar" };

    const duration = typeof args.newDurationMin === "number" ? args.newDurationMin : appt.durationMin;
    if (await hasScheduleConflict(ctx.est.id, args.newStartAt, duration, appt.id)) {
      return { ok: false, error: "esse horário acabou de ser ocupado; ofereça outro" };
    }

    await updateAppointment(ctx.est.id, appt.id, {
      startAt: args.newStartAt,
      durationMin: duration,
      status: "pending",
      confirmedAt: null,
      reminderSentAt: null,
    });
    return { ok: true, data: { when: formatWhen(args.newStartAt, ctx.offset), serviceName: appt.serviceName } };
  },
};

// ---- cancelAppointment ----
const cancelAppointment: ToolDefinition = {
  name: "cancel_appointment",
  enabled: (ctx) => ctx.est.bot.bookingEnabled,
  schema: fn("cancel_appointment", "Cancela o próximo agendamento ativo do cliente.", {
    type: "object",
    properties: {},
  }),
  async execute(ctx) {
    const appt = await findNextAppointment(ctx.est.id, normalizePhone(ctx.contactPhone));
    if (!appt) return { ok: false, error: "nenhum agendamento ativo encontrado para cancelar" };
    await setStatus(ctx.est.id, appt.id, "cancelled");
    return { ok: true, data: { serviceName: appt.serviceName } };
  },
};

// ---- requestHumanHandoff ----
// Não toca Firestore aqui — só sinaliza a intenção. Quem grava a
// transição de status ("handoff") é app/api/webhooks/whatsapp/route.ts,
// depois de ver que esta ferramenta foi chamada (ver BrainResult.handoff em
// lib/ai/brain.ts). Mantém o mesmo princípio das outras ferramentas: o
// backend é quem decide o efeito real, a IA só solicita.
const requestHumanHandoff: ToolDefinition = {
  name: "request_human_handoff",
  enabled: () => true,
  schema: fn(
    "request_human_handoff",
    "Solicita transferência para um atendente humano. Use quando o cliente pedir explicitamente, demonstrar irritação, ou pedir algo fora do seu escopo.",
    {
      type: "object",
      properties: { reason: { type: "string", description: "motivo curto, para o atendente entender o contexto" } },
    },
  ),
  async execute(_ctx, args) {
    return { ok: true, data: { reason: typeof args.reason === "string" ? args.reason : null } };
  },
};

export const TOOL_REGISTRY: ToolDefinition[] = [
  getBusinessHours,
  searchKnowledgeBase,
  getCustomerProfileTool,
  updateCustomerProfile,
  getCustomerAppointments,
  findAvailableAppointments,
  createAppointmentTool,
  confirmAppointment,
  rescheduleAppointment,
  cancelAppointment,
  requestHumanHandoff,
];

export function toolsFor(ctx: ToolContext): OpenAI.Chat.ChatCompletionTool[] {
  return TOOL_REGISTRY.filter((t) => t.enabled(ctx)).map((t) => t.schema);
}

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOL_REGISTRY.find((t) => t.name === name && t.enabled(ctx));
  if (!tool) return { ok: false, error: `ferramenta desconhecida ou indisponível: ${name}` };
  try {
    return await tool.execute(ctx, args);
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function formatWhen(startAt: number, offsetMin: number): string {
  const d = new Date(startAt + offsetMin * 60000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} às ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// ---- Datas relativas resolvidas no BACKEND ----
// O modelo errou "hoje/amanhã" porque ninguém resolvia isso pra ele: ele
// recebia só epochs e o texto "Hoje é ...". Estas funções convertem um
// instante para o calendário LOCAL do estabelecimento (utcOffsetMinutes) e
// devolvem rótulo/data prontos — nenhuma inferência de data fica com a IA.
export function startOfLocalDay(at: number, offsetMin: number): number {
  const local = new Date(at + offsetMin * 60000);
  const midnightLocalAsUtc = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return midnightLocalAsUtc - offsetMin * 60000;
}

export function localDateString(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
}

export function localTimeString(at: number, offsetMin: number): string {
  const d = new Date(at + offsetMin * 60000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// "hoje" / "amanhã" / "depois de amanhã" / a data concreta. Comparação por
// dia de calendário local, nunca por diferença de horas (00:30 de amanhã
// está a 1h de distância e ainda assim é "amanhã").
export function relativeDayLabel(at: number, offsetMin: number, now = Date.now()): string {
  const startToday = startOfLocalDay(now, offsetMin);
  const startTarget = startOfLocalDay(at, offsetMin);
  const diffDays = Math.round((startTarget - startToday) / (24 * 3600000));
  if (diffDays === 0) return "hoje";
  if (diffDays === 1) return "amanhã";
  if (diffDays === -1) return "ontem";
  return localDateString(at, offsetMin);
}
