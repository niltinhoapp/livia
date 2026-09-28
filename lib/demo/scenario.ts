// AMBIENTE OFICIAL DE DEMONSTRAÇÃO — cenário fictício baseline (F2).
//
// ---- O QUE ESTE MÓDULO É E O QUE NÃO É ----
//
// A demonstração tem que PROVAR o produto. Então a regra é:
//
//   DADOS FICTÍCIOS CONTROLADOS  ->  MESMAS REGRAS REAIS  ->  MESMAS TOOLS
//
// Este módulo fornece exclusivamente a primeira etapa: a OCUPAÇÃO fictícia da
// agenda de demonstração. Ele NUNCA decide disponibilidade. Quem decide
// continua sendo `slotBookability`/`computeSlots` (lib/scheduling.ts), a mesma
// e única regra usada pela agenda real — expediente, pausa, antecedência,
// duração e sobreposição.
//
// Portanto: nada aqui é um mock de RESPOSTA. É um conjunto de dados de
// entrada, declarado num documento do Firestore, sobre o qual o motor real
// roda. A diferença entre "8h está ocupado" na demo e em produção é a ORIGEM
// do dado, nunca o caminho da decisão.
//
// ---- POR QUE O BASELINE É MATERIALIZADO POR DATA, E NÃO SEMEADO ----
//
// O prospect pergunta "tem horário amanhã?". Se o baseline fossem documentos
// semeados em datas fixas, a demonstração só funcionaria naqueles dias e
// exigiria um cron para rolar as datas adiante — e os documentos cresceriam
// para sempre, que é exatamente o problema de lifecycle que a F2 pede para
// evitar.
//
// Em vez disso o baseline é um PADRÃO SEMANAL declarado em
// `establishments/{id}/meta/demoScenario` e materializado em memória para a
// data consultada. Uma única fonte, explícita, versionada e resetável, que
// vale para qualquer dia que o prospect pedir e não deixa resíduo.
//
// As MUTAÇÕES da demonstração (criar/remarcar/cancelar) NÃO são materializadas:
// são Appointments reais e persistidos, com `mode: "demo"` e
// `prospectingLeadId`, executados pelas transações reais da agenda. É isso que
// faz a demonstração ser real e auditável.
//
// ---- PRIVACIDADE ----
//
// O baseline representa "horários de outras pessoas". Ele carrega apenas hora,
// duração e um NOME DE SERVIÇO fictício — nunca nome, telefone, mensagem ou
// qualquer referência a pessoa. `contactName` é sempre null e `contactPhone` é
// um marcador constante que não é um telefone e nunca é comparado com o de um
// contato: o baseline não é alvo de mutação e não aparece em
// `get_customer_appointments`, então nenhum caminho o expõe como "agendamento
// do cliente".
import type { Appointment, DemoScenario, DemoScenarioSlot } from "@/types";
import { localToEpoch, weekdayOf } from "@/lib/scheduling";

/** Marcador de contato do baseline. Não é telefone e nunca é exibido. */
export const DEMO_BASELINE_CONTACT = "demo-baseline";

/** Prefixo de id determinístico — mesmo dia produz sempre os mesmos ids. */
export const DEMO_BASELINE_ID_PREFIX = "demo-baseline";

/** 24h é suficiente para uma conversa de demonstração inteira. */
export const DEFAULT_DEMO_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Coerente com o expediente canônico default (Seg-Sex 09:00-18:00 com pausa
// 12:00-13:00, Sáb 09:00-13:00): declarar ocupação às 08:00 seria inócuo,
// porque o dia só abre às 09:00 e o motor já recusaria o horário por
// `outside_hours`. Sobram livres 10:00, 10:30, 13:00, 14:00, 16:00 e 17:00 —
// a demonstração precisa ter o que reservar.
const WEEKDAY_SLOTS: DemoScenarioSlot[] = [
  { time: "09:00", serviceName: "Corte", durationMin: 30 },
  { time: "09:30", serviceName: "Unhas", durationMin: 30 },
  { time: "11:00", serviceName: "Coloração", durationMin: 60 },
  { time: "15:00", serviceName: "Escova", durationMin: 30 },
];

const SATURDAY_SLOTS: DemoScenarioSlot[] = [
  { time: "09:00", serviceName: "Corte", durationMin: 30 },
  { time: "10:30", serviceName: "Barba", durationMin: 30 },
];

/**
 * Cenário default. Deliberadamente NÃO lota o dia: precisa sobrar horário
 * livre para a demonstração poder reservar — se o padrão fechasse o dia, a
 * demo voltaria a responder "não há horários livres", que é o defeito que a
 * F2 existe para eliminar.
 *
 * Os dias seguem o expediente canônico default (Seg-Sex com pausa de almoço,
 * Sáb até as 13h, Dom fechado): o cenário só declara OCUPAÇÃO, nunca abre um
 * dia que a `ScheduleConfig` do estabelecimento mantém fechado.
 */
export function defaultDemoScenario(establishmentId: string, now = Date.now()): DemoScenario {
  return {
    establishmentId,
    weekly: {
      "0": [],
      "1": WEEKDAY_SLOTS,
      "2": WEEKDAY_SLOTS,
      "3": WEEKDAY_SLOTS,
      "4": WEEKDAY_SLOTS,
      "5": WEEKDAY_SLOTS,
      "6": SATURDAY_SLOTS,
    },
    sessionTtlMs: DEFAULT_DEMO_SESSION_TTL_MS,
    updatedAt: now,
  };
}

function isSlot(value: unknown): value is DemoScenarioSlot {
  if (!value || typeof value !== "object") return false;
  const slot = value as Partial<DemoScenarioSlot>;
  return (
    typeof slot.time === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time) &&
    typeof slot.serviceName === "string" &&
    slot.serviceName.trim().length > 0 &&
    typeof slot.durationMin === "number" &&
    Number.isFinite(slot.durationMin) &&
    slot.durationMin > 0 &&
    slot.durationMin <= 8 * 60
  );
}

/**
 * Normaliza um documento persistido. Um cenário corrompido ou parcial NUNCA
 * vira ocupação inventada nem quebra a demonstração: o dia inválido é lido
 * como sem ocupação, e a decisão continua com o motor real.
 */
export function normalizeDemoScenario(establishmentId: string, raw: unknown, now = Date.now()): DemoScenario {
  if (!raw || typeof raw !== "object") return defaultDemoScenario(establishmentId, now);
  const input = raw as Partial<DemoScenario>;
  const weeklyRaw = input.weekly;
  if (!weeklyRaw || typeof weeklyRaw !== "object") return defaultDemoScenario(establishmentId, now);

  const weekly: DemoScenario["weekly"] = {};
  for (const weekday of ["0", "1", "2", "3", "4", "5", "6"]) {
    const slots = (weeklyRaw as Record<string, unknown>)[weekday];
    weekly[weekday] = Array.isArray(slots) ? slots.filter(isSlot) : [];
  }

  const ttl = input.sessionTtlMs;
  return {
    establishmentId,
    weekly,
    sessionTtlMs: typeof ttl === "number" && Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_DEMO_SESSION_TTL_MS,
    updatedAt: typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt) ? input.updatedAt : now,
  };
}

/** A ocupação fictícia declarada para um dia, sem materializar Appointment. */
export function demoScenarioSlotsForDate(scenario: DemoScenario, date: string): DemoScenarioSlot[] {
  return scenario.weekly[String(weekdayOf(date))] ?? [];
}

/**
 * Materializa a ocupação fictícia de UMA data como Appointments em memória,
 * no formato que `slotBookability`/`computeSlots` consomem.
 *
 * Nunca persistido. Ids determinísticos (`demo-baseline:{date}:{time}`) para
 * que duas leituras do mesmo dia produzam exatamente a mesma ocupação — sem
 * isso, `excludeId` numa remarcação poderia deixar de casar entre chamadas.
 */
export function materializeDemoBaseline(
  scenario: DemoScenario,
  date: string,
  utcOffsetMinutes: number,
): Appointment[] {
  return demoScenarioSlotsForDate(scenario, date).map((slot) => {
    const [hour, minute] = slot.time.split(":").map(Number);
    return {
      id: `${DEMO_BASELINE_ID_PREFIX}:${date}:${slot.time}`,
      establishmentId: scenario.establishmentId,
      contactPhone: DEMO_BASELINE_CONTACT,
      contactName: null,
      serviceName: slot.serviceName,
      startAt: localToEpoch(date, hour! * 60 + minute!, utcOffsetMinutes),
      durationMin: slot.durationMin,
      status: "confirmed",
      source: "manual",
      note: null,
      createdAt: 0,
      confirmedAt: 0,
      reminderSentAt: null,
      mode: "demo",
      prospectingLeadId: null,
      demoBaseline: true,
    } satisfies Appointment;
  });
}

export function isDemoBaselineAppointment(a: Pick<Appointment, "demoBaseline">): boolean {
  return a.demoBaseline === true;
}
