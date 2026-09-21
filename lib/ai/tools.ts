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
import type { Appointment, Establishment, ScheduleConfig, KnowledgeBase, CustomerProfile, OrderPaymentMethod, FoodOrder } from "@/types";
import {
  listAppointments,
  listActiveCustomerAppointments,
  getAppointment,
  computeSlots,
  createAppointment,
  localToEpoch,
  assertBookable,
  resolveServiceDuration,
  type NotBookableReason,
  updateAppointment,
  setStatus,
  weekdayOf,
  isActive,
  getScheduleConfig,
} from "@/lib/scheduling";
import { getCustomerProfile, upsertCustomerProfile } from "@/lib/repo";
import { normalizePhone } from "@/lib/whatsapp/client";
const orderService = () => import("@/lib/orders");

export interface ToolContext {
  est: Establishment;
  kb: KnowledgeBase | null;
  config: ScheduleConfig | null; // null quando bot.bookingEnabled é false
  contactPhone: string;
  contactName: string | null;
  offset: number; // utcOffsetMinutes efetivo (config, ou -180 sem config)
  customerProfile: CustomerProfile | null;
  // Dia que a conversa está tratando (YYYY-MM-DD), decidido por código: a
  // data que o cliente disse agora, ou a que já estava na tarefa. Serve de
  // VALIDAÇÃO do startAt proposto pelo modelo — ver assertSameDay abaixo.
  discussedDate?: string | null;
  // Contexto persistido e calculado antes do loop. A tool de confirmação não
  // aceita que o modelo escolha pedido, versão ou a existência de um "sim".
  orderConfirmation?: { orderId: string; version: number; explicitlyConfirmed: boolean } | null;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  // Motivo estruturado quando um horário não é reservável — o modelo
  // comunica, mas quem decidiu foi o backend (ver slotBookability).
  reasonCode?: NotBookableReason;
}

const NOT_BOOKABLE_MESSAGE: Record<NotBookableReason, string> = {
  closed_day: "o estabelecimento não abre nesse dia; ofereça outro dia",
  outside_hours: "esse horário está fora do expediente; ofereça um horário dentro do funcionamento",
  during_break: "esse horário cai no intervalo de almoço; ofereça outro",
  too_soon: "esse horário está muito próximo de agora (antecedência mínima); ofereça um mais adiante",
  overlap: "esse horário acabou de ser ocupado; ofereça outro",
};

// Dia local (no fuso do estabelecimento) de um instante — inverso exato de
// localToEpoch.
function localDateOf(startAt: number, offset: number): string {
  const d = new Date(startAt + offset * 60000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// O startAt proposto cai no dia que a conversa está tratando?
//
// Rede de segurança da auditoria de 06/09/2026. A noite inteira teve o mesmo
// sintoma por caminhos diferentes: a listagem oferecia horários de um dia e a
// criação recebia um instante de OUTRO dia, devolvendo "muito próximo"
// (horário de hoje já passado) ou "fechado" (hoje é domingo) para um dia que
// estava aberto. O cliente chegou a perguntar "pq vc esta mostrando horios q
// nao pode agendar?".
//
// Em vez de perseguir a origem do dia errado caso a caso, o sistema passa a
// checar o fato: se a conversa está tratando 10/09, um startAt de 06/09 é um
// erro, venha ele de onde vier. Devolve erro em vez de corrigir sozinho —
// reservar no dia errado silenciosamente seria pior que recusar, e o modelo
// tem a data certa no prompt para tentar de novo.
//
// Só age quando há um dia em discussão; sem isso, não há o que comparar.
function assertSameDay(ctx: ToolContext, startAt: number): ToolResult | null {
  if (!ctx.discussedDate) return null;
  const dia = localDateOf(startAt, ctx.offset);
  if (dia === ctx.discussedDate) return null;
  return {
    ok: false,
    error:
      `esse horário cai em ${dia}, mas a conversa está tratando o dia ${ctx.discussedDate}. ` +
      `Use um horário do dia ${ctx.discussedDate}.`,
  };
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
    "Retorna os horários livres REAIS de um dia. Use antes de oferecer qualquer horário — nunca chute. Informe o serviço para que a duração correta seja aplicada.",
    {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD" },
        serviceName: { type: "string", description: "Serviço desejado, como o cliente pediu" },
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
    // Duração é decisão do BACKEND, nunca do modelo — ver
    // resolveServiceDuration em lib/scheduling.ts.
    const serviceName = typeof args.serviceName === "string" ? args.serviceName : undefined;
    const duration = resolveServiceDuration(config, ctx.kb?.services, serviceName);
    const dayStart = localToEpoch(date, 0, config.utcOffsetMinutes);
    const existing = await listAppointments(ctx.est.id, dayStart, dayStart + 24 * 3600000);
    const slots = computeSlots(config, date, duration, existing).slice(0, 12);
    if (slots.length === 0) return { ok: true, data: { date, slots: [], note: "Sem horários livres neste dia." } };
    // `durationMin` volta só como informação: quem cria resolve de novo pela
    // mesma função, então listagem e criação não têm como divergir.
    return { ok: true, data: { date, durationMin: duration, slots } };
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
      contactName: { type: "string", description: "nome do cliente, se souber" },
    },
    required: ["serviceName", "startAt"],
  }),
  async execute(ctx, args) {
    if (typeof args.serviceName !== "string" || typeof args.startAt !== "number") {
      return { ok: false, error: "serviceName e startAt são obrigatórios" };
    }
    const config = ctx.config!;
    const diaErrado = assertSameDay(ctx, args.startAt);
    if (diaErrado) return diaErrado;

    // MESMA resolução de duração usada na listagem — é isso que garante que
    // um horário oferecido continue reservável aqui.
    const duration = resolveServiceDuration(config, ctx.kb?.services, args.serviceName);

    // Validação final com a MESMA regra da listagem, relendo a agenda (protege
    // contra concorrência real entre a oferta e a escolha).
    const reason = await assertBookable(ctx.est.id, config, args.startAt, duration);
    if (reason) return { ok: false, error: NOT_BOOKABLE_MESSAGE[reason], reasonCode: reason };

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

    // listActiveCustomerAppointments já pagina e filtra: cancelamentos não
    // consomem o limite nem escondem um agendamento ativo.
    const active = await listActiveCustomerAppointments(ctx.est.id, normalizePhone(ctx.contactPhone), from);

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
          description: "id vindo de get_customer_appointments; obrigatório quando o cliente tem mais de um agendamento ativo.",
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
      const ativos = await listActiveCustomerAppointments(ctx.est.id, phone, Date.now());
      if (ativos.length > 1) {
        return {
          ok: false,
          error:
            "o cliente tem mais de um agendamento ativo; pergunte QUAL deles ele quer confirmar e chame de novo com appointmentId",
          data: {
            appointments: ativos.map((a) => ({
              id: a.id,
              serviceName: a.serviceName,
              when: formatWhen(a.startAt, config.utcOffsetMinutes),
              status: a.status,
            })),
          },
        };
      }
      target = ativos[0] ?? null;
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
// Remarca UM agendamento, identificado por id quando o cliente tem mais de
// um ativo.
//
// Antes operava sempre sobre o PRÓXIMO agendamento na ordem cronológica, o
// que produziu o pior erro de dado da noite de 06/09/2026: o cliente estava
// remarcando a Limpeza de 09/09 13:00 e o sistema moveu a Avaliação de 07/09
// 13:00 (a primeira da fila), respondendo "seu horário de Avaliação foi
// remarcado". Um cliente real perderia o horário sem ser avisado.
//
// O cancelamento já resolvia isto perguntando "qual dos dois?"
// (resolveCancellation em lib/ai/brain.ts); a remarcação nunca teve essa
// desambiguação. Com um único agendamento ativo o comportamento é o mesmo de
// antes; com vários, a ferramenta se recusa a escolher e devolve a lista
// para que a pessoa diga qual — escolher sozinha é justamente o erro.
const rescheduleAppointment: ToolDefinition = {
  name: "reschedule_appointment",
  enabled: (ctx) => ctx.est.bot.bookingEnabled,
  schema: fn(
    "reschedule_appointment",
    "Remarca um agendamento do cliente para um novo horário. Se ele tiver mais de um agendamento ativo, informe appointmentId (vindo de get_customer_appointments) — nunca escolha por conta própria. Use find_available_appointments antes para confirmar que o novo horário está livre.",
    {
      type: "object",
      properties: {
        newStartAt: { type: "number", description: "epoch em ms do novo horário, vindo de find_available_appointments" },
        appointmentId: { type: "string", description: "id do agendamento a remarcar; obrigatório quando há mais de um ativo" },
      },
      required: ["newStartAt"],
    },
  ),
  async execute(ctx, args) {
    if (typeof args.newStartAt !== "number") return { ok: false, error: "newStartAt é obrigatório" };
    const diaErrado = assertSameDay(ctx, args.newStartAt);
    if (diaErrado) return diaErrado;

    const ativos = await listActiveCustomerAppointments(ctx.est.id, normalizePhone(ctx.contactPhone), Date.now());
    if (ativos.length === 0) return { ok: false, error: "nenhum agendamento ativo encontrado para remarcar" };

    const pedido = typeof args.appointmentId === "string" ? args.appointmentId : undefined;
    let appt = pedido ? ativos.find((a) => a.id === pedido) : undefined;

    if (!appt) {
      if (pedido) return { ok: false, error: "esse agendamento não está ativo para este cliente" };
      if (ativos.length > 1) {
        // Ambíguo: devolve a lista em vez de adivinhar.
        return {
          ok: false,
          error:
            "o cliente tem mais de um agendamento ativo; pergunte QUAL deles ele quer remarcar e chame de novo com appointmentId",
          data: {
            appointments: ativos.map((a) => ({
              id: a.id,
              serviceName: a.serviceName,
              when: formatWhen(a.startAt, ctx.offset),
            })),
          },
        };
      }
      appt = ativos[0]!;
    }

    // Duração do BACKEND (pelo serviço do próprio agendamento), nunca do
    // modelo — e a MESMA regra de reservabilidade da listagem/criação, senão
    // uma remarcação poderia cair dentro do almoço ou fora do expediente.
    const duration = resolveServiceDuration(ctx.config!, ctx.kb?.services, appt.serviceName);
    const reason = await assertBookable(ctx.est.id, ctx.config!, args.newStartAt, duration, Date.now(), appt.id);
    if (reason) return { ok: false, error: NOT_BOOKABLE_MESSAGE[reason], reasonCode: reason };

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
  schema: fn(
    "cancel_appointment",
    "Cancela UM agendamento específico do cliente, identificado pelo id. Só use depois que a pessoa tiver confirmado explicitamente que quer cancelar aquele horário.",
    {
      type: "object",
      properties: {
        appointmentId: { type: "string", description: "id vindo de get_customer_appointments" },
      },
      required: ["appointmentId"],
    },
  ),
  // Exige o id de propósito. Antes cancelava "o próximo agendamento ativo"
  // (findNextAppointment) sem alvo explícito: com dois horários marcados,
  // "cancela esse" apagava silenciosamente o mais próximo, que pode não ser
  // o que estava sendo conversado. Quem resolve qual é "esse" é o backend
  // (ver resolveCancellation em lib/ai/brain.ts), nunca o modelo por
  // omissão.
  async execute(ctx, args) {
    if (typeof args.appointmentId !== "string" || !args.appointmentId) {
      return { ok: false, error: "appointmentId é obrigatório — consulte get_customer_appointments antes" };
    }
    const appt = await getAppointment(ctx.est.id, args.appointmentId);
    // Trava de posse: um id vindo do modelo nunca pode alcançar o
    // agendamento de outra pessoa.
    if (!appt || normalizePhone(appt.contactPhone) !== normalizePhone(ctx.contactPhone)) {
      return { ok: false, error: "agendamento não encontrado para este cliente" };
    }
    if (!isActive(appt)) {
      return { ok: false, error: `este agendamento já está "${appt.status}"` };
    }
    await setStatus(ctx.est.id, appt.id, "cancelled");
    const config = ctx.config ?? (await getScheduleConfig(ctx.est.id));
    return {
      ok: true,
      data: {
        cancelled: true,
        id: appt.id,
        serviceName: appt.serviceName,
        when: formatWhen(appt.startAt, config.utcOffsetMinutes),
        day: relativeDayLabel(appt.startAt, config.utcOffsetMinutes),
      },
    };
  },
};

// Duas linhas do MESMO produto, com a mesma variação e os mesmos adicionais,
// quase sempre é o cliente repetindo o pedido por engano — mensagens iguais
// somam itens, por decisão de produto. Marcar a repetição aqui deixa a Livia
// conferir a quantidade antes de fechar, em vez de o cliente só descobrir
// quando o pedido chegar dobrado.
const itemFingerprint = (item: FoodOrder["items"][number]) =>
  [item.productId, item.variantId ?? "", ...item.modifiers.map((m) => m.optionId).sort()].join("|");

function orderSummary(order: FoodOrder | null, pixInstructions?: string | null) {
  if (!order) return null;
  const occurrences = new Map<string, number>();
  for (const item of order.items) {
    const key = itemFingerprint(item);
    occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  }
  return { id: order.id, status: order.status, version: order.version, items: order.items.map((item) => ({ id: item.id, name: item.productName, variant: item.variantName, quantity: item.quantity, modifiers: item.modifiers.map((m) => m.name), notes: item.notes, lineTotalCents: item.lineTotalCents, repeatedProduct: (occurrences.get(itemFingerprint(item)) ?? 0) > 1 })), fulfillment: order.fulfillment, deliveryAddress: order.deliveryAddress, payment: order.payment, subtotalCents: order.subtotalCents, discountCents: order.discountCents ?? 0, deliveryFeeCents: order.deliveryFeeCents, totalCents: order.totalCents, ...(pixInstructions ? { pixInstructions } : {}) };
}

// Instruções de PIX cadastradas pelo estabelecimento. São TEXTO para a Livia
// repassar — não confirmam pagamento nenhum: o estado financeiro do pedido só
// muda por evento do backend, nunca por comprovante ou palavra do cliente.
async function pixInstructionsFor(ctx: ToolContext, order: FoodOrder | null): Promise<string | null> {
  if (order?.payment.method !== "pix") return null;
  return (await (await orderService()).getOrderSettings(ctx.est.id)).pixInstructions;
}
const orderConversationId = (ctx: ToolContext) => normalizePhone(ctx.contactPhone);
// __operationId é metadado injetado pelo loop de tool calls em brain.ts.
// Não integra o schema público e, portanto, não pode ser escolhido pelo modelo.
const operationIdFor = (args: Record<string, unknown>) =>
  typeof args.__operationId === "string" && args.__operationId.length > 0
    ? args.__operationId
    : undefined;
function orderMutationFailure(error: unknown) {
  const status = error && typeof error === "object" ? (error as { status?: { reason?: unknown; nextOpening?: unknown } }).status : null;
  if (status?.reason === "orders_disabled" || status?.reason === "outside_order_hours") {
    return { ok: false as const, error: String(status.reason), data: { reason: status.reason, nextOpening: status.nextOpening ?? null } };
  }
  return { ok: false as const, error: String(error) };
}
const searchMenu: ToolDefinition = { name: "search_menu", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("search_menu", "Busca produtos DISPONÍVEIS no cardápio real. Use antes de adicionar itens ou informar preço; nunca invente produto, adicional ou valor.", { type: "object", properties: { query: { type: "string" } }, required: ["query"] }), async execute(ctx, args) { const query = typeof args.query === "string" ? args.query.trim().toLocaleLowerCase("pt-BR") : ""; if (!query) return { ok: false, error: "query obrigatória" }; const products = (await (await orderService()).listAvailableMenuProducts(ctx.est.id)).filter((p) => `${p.name} ${p.description ?? ""}`.toLocaleLowerCase("pt-BR").includes(query)).slice(0, 12); return { ok: true, data: { products: products.map((p) => ({ id: p.id, name: p.name, description: p.description, basePriceCents: p.basePriceCents, variants: p.variants.filter((v) => v.active), modifierGroups: p.modifierGroups.map((g) => ({ id: g.id, name: g.name, required: g.required, minSelections: g.minSelections, maxSelections: g.maxSelections, options: g.options.filter((o) => o.active) })) })) } }; } };
const getMenuProductTool: ToolDefinition = { name: "get_menu_product", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("get_menu_product", "Retorna composição e preço REAIS de um produto pelo id recebido em search_menu.", { type: "object", properties: { productId: { type: "string" } }, required: ["productId"] }), async execute(ctx, args) { const product = typeof args.productId === "string" ? await (await orderService()).getAvailableMenuProduct(ctx.est.id, args.productId) : null; return product ? { ok: true, data: product } : { ok: false, error: "produto indisponível" }; } };
// Teto de itens na listagem do cardápio inteiro: cardápio grande não pode
// estourar o contexto da conversa. Passando disso, a Livia avisa que há mais
// e pede um direcionamento em vez de despejar tudo.
const MAX_MENU_PRODUCTS = 60;
const listMenuTool: ToolDefinition = { name: "list_menu", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("list_menu", "Lista o cardápio completo, agrupado por categoria. Use quando o cliente pedir o cardápio ou perguntar o que tem, sem citar um item específico.", { type: "object", properties: {} }), async execute(ctx) { const menu = await (await orderService()).listAvailableMenu(ctx.est.id); let remaining = MAX_MENU_PRODUCTS; const categories = []; for (const category of menu) { if (remaining <= 0) break; const products = category.products.slice(0, remaining); remaining -= products.length; categories.push({ name: category.name, products: products.map((p) => ({ id: p.id, name: p.name, description: p.description ? p.description.slice(0, 80) : null, basePriceCents: p.basePriceCents, hasVariants: p.variants.some((v) => v.active), hasModifiers: p.modifierGroups.length > 0 })) }); } const total = menu.reduce((sum, c) => sum + c.products.length, 0); return { ok: true, data: { categories, truncated: total > MAX_MENU_PRODUCTS } }; } };
const getOrderDraftTool: ToolDefinition = { name: "get_order_draft", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("get_order_draft", "Retorna o resumo canônico do pedido atual, incluindo total calculado pelo backend. Use antes de apresentar total ou pedir confirmação.", { type: "object", properties: {} }), async execute(ctx) { const order = await (await orderService()).getActiveOrder(ctx.est.id, orderConversationId(ctx)); return { ok: true, data: orderSummary(order, await pixInstructionsFor(ctx, order)) }; } };
const addOrderItemTool: ToolDefinition = { name: "add_order_item", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("add_order_item", "Adiciona produto ao pedido usando IDs de search_menu/get_menu_product. O backend valida disponibilidade, variação, adicionais e preço.", { type: "object", properties: { productId: { type: "string" }, variantId: { type: "string" }, modifierOptionIds: { type: "array", items: { type: "string" } }, quantity: { type: "number" }, notes: { type: "string" } }, required: ["productId", "quantity"] }), async execute(ctx, args) { try { const order = await (await orderService()).addOrderItem(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, ctx.contactName, String(args.productId ?? ""), typeof args.variantId === "string" ? args.variantId : null, Array.isArray(args.modifierOptionIds) ? args.modifierOptionIds.filter((v): v is string => typeof v === "string") : [], Number(args.quantity), typeof args.notes === "string" ? args.notes : null, operationIdFor(args), Boolean(args.__allowDraftCreation)); return { ok: true, data: orderSummary(order) }; } catch (e) { return orderMutationFailure(e); } } };
const updateOrderItemTool: ToolDefinition = { name: "update_order_item", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("update_order_item", "Altera um item que já está no pedido: quantidade, observação, tamanho/variação ou adicionais. Use o itemId do resumo e os IDs reais de variação/adicional do produto. O backend recalcula o preço; nunca informe valor.", { type: "object", properties: { itemId: { type: "string" }, quantity: { type: "number" }, notes: { type: "string" }, variantId: { type: ["string", "null"], description: "id da variação; null remove a variação atual" }, modifierOptionIds: { type: "array", items: { type: "string" }, description: "lista COMPLETA de adicionais que o item deve ficar, não só os novos" } }, required: ["itemId"] }), async execute(ctx, args) { try { const order = await (await orderService()).updateOrderItem(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, ctx.contactName, String(args.itemId ?? ""), { quantity: typeof args.quantity === "number" ? args.quantity : undefined, notes: typeof args.notes === "string" ? args.notes : undefined, variantId: args.variantId === null ? null : typeof args.variantId === "string" ? args.variantId : undefined, modifierOptionIds: Array.isArray(args.modifierOptionIds) ? args.modifierOptionIds.filter((v): v is string => typeof v === "string") : undefined }, operationIdFor(args)); return { ok: true, data: orderSummary(order) }; } catch (e) { return orderMutationFailure(e); } } };
const removeOrderItemTool: ToolDefinition = { name: "remove_order_item", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("remove_order_item", "Remove um item identificado pelo itemId do resumo atual.", { type: "object", properties: { itemId: { type: "string" } }, required: ["itemId"] }), async execute(ctx, args) { try { return { ok: true, data: orderSummary(await (await orderService()).removeOrderItem(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, ctx.contactName, String(args.itemId ?? ""), operationIdFor(args))) }; } catch (e) { return orderMutationFailure(e); } } };
const setOrderFulfillmentTool: ToolDefinition = { name: "set_order_fulfillment", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("set_order_fulfillment", "Define retirada ou entrega. Nunca estime taxa: o backend calcula.", { type: "object", properties: { fulfillment: { type: "string", enum: ["pickup", "delivery"] } }, required: ["fulfillment"] }), async execute(ctx, args) { try { const fulfillment = args.fulfillment === "pickup" || args.fulfillment === "delivery" ? args.fulfillment : null; if (!fulfillment) throw new Error("modalidade inválida"); return { ok: true, data: orderSummary(await (await orderService()).setOrderFulfillment(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, ctx.contactName, fulfillment, operationIdFor(args))) }; } catch (e) { return orderMutationFailure(e); } } };
const setOrderAddressTool: ToolDefinition = { name: "set_order_address", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("set_order_address", "Registra o endereço informado pelo cliente para entrega. Pergunte bairro se houver taxa por bairro e não invente dados.", { type: "object", properties: { raw: { type: "string" }, neighborhood: { type: "string" }, reference: { type: "string" } }, required: ["raw"] }), async execute(ctx, args) { try { return { ok: true, data: orderSummary(await (await orderService()).setOrderAddress(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, ctx.contactName, String(args.raw ?? ""), typeof args.neighborhood === "string" ? args.neighborhood : null, typeof args.reference === "string" ? args.reference : null, operationIdFor(args))) }; } catch (e) { return orderMutationFailure(e); } } };
const setOrderPaymentTool: ToolDefinition = { name: "set_order_payment", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("set_order_payment", "Define a forma de pagamento aceita pelo estabelecimento. Não processa pagamento nem usa billing SaaS.", { type: "object", properties: { method: { type: "string", enum: ["pix", "cash", "credit_card", "debit_card"] }, changeForCents: { type: "number" } }, required: ["method"] }), async execute(ctx, args) { try { const method = args.method as OrderPaymentMethod; if (!["pix", "cash", "credit_card", "debit_card"].includes(method)) throw new Error("forma inválida"); const order = await (await orderService()).setOrderPayment(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, ctx.contactName, method, typeof args.changeForCents === "number" ? args.changeForCents : null, operationIdFor(args)); return { ok: true, data: orderSummary(order, await pixInstructionsFor(ctx, order)) }; } catch (e) { return orderMutationFailure(e); } } };
const prepareOrderConfirmationTool: ToolDefinition = { name: "prepare_order_confirmation", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("prepare_order_confirmation", "Gera o resumo canônico e coloca o pedido em aguardando confirmação. Use somente quando todos os itens, retirada/entrega, endereço e pagamento já estiverem definidos.", { type: "object", properties: {} }), async execute(ctx, args) { try { const order = await (await orderService()).prepareOrderConfirmation(ctx.est.id, orderConversationId(ctx), ctx.contactPhone, operationIdFor(args)); return { ok: true, data: orderSummary(order, await pixInstructionsFor(ctx, order)) }; } catch (e) { return { ok: false, error: String(e) }; } } };
const confirmOrderTool: ToolDefinition = { name: "confirm_order", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("confirm_order", "Fecha o pedido somente quando a mensagem atual do cliente for uma confirmação explícita do resumo canônico pendente.", { type: "object", properties: {} }), async execute(ctx, args) { try { const confirmation = ctx.orderConfirmation; if (!confirmation?.explicitlyConfirmed) throw new Error("Ainda preciso de uma confirmação explícita do resumo para fechar o pedido."); const order = await (await orderService()).confirmOrder(ctx.est.id, confirmation.orderId, confirmation.version, ctx.contactPhone, operationIdFor(args)); return { ok: true, data: orderSummary(order) }; } catch (e) { return { ok: false, error: String(e) }; } } };
const getOrderStatusTool: ToolDefinition = { name: "get_order_status", enabled: (ctx) => Boolean(ctx.est.bot.ordersEnabled), schema: fn("get_order_status", "Consulta o estado real de um pedido do próprio cliente.", { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] }), async execute(ctx, args) { const order = await (await orderService()).getOrder(ctx.est.id, String(args.orderId ?? "")); return order && normalizePhone(order.contactPhone) === normalizePhone(ctx.contactPhone) ? { ok: true, data: orderSummary(order) } : { ok: false, error: "pedido não encontrado para este cliente" }; } };

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
  getCustomerProfileTool,
  updateCustomerProfile,
  getCustomerAppointments,
  findAvailableAppointments,
  createAppointmentTool,
  confirmAppointment,
  rescheduleAppointment,
  cancelAppointment,
  listMenuTool, searchMenu, getMenuProductTool, getOrderDraftTool, addOrderItemTool, updateOrderItemTool, removeOrderItemTool, setOrderFulfillmentTool, setOrderAddressTool, setOrderPaymentTool, prepareOrderConfirmationTool, confirmOrderTool, getOrderStatusTool,
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
