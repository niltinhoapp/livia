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
import type { Establishment, ScheduleConfig, KnowledgeBase, CustomerProfile } from "@/types";
import {
  listAppointments,
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
  findAvailableAppointments,
  createAppointmentTool,
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
