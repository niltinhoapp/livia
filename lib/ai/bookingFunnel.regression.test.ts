// Regressão do bug real de Production em 02/09 (Pacote 3).
//
// Fluxo que aconteceu de verdade:
//   1. cliente: "Agenda pra amanhã!! As 9"
//   2. Livia pergunta o serviço
//   3. cliente: "Avaliação"
//   4. create_appointment devolve sucesso, Appointment persistido para 03/09
//      09:00, status "pending" (aguardando na agenda)
//
// O painel mostrava: atendimentos 1, intenção de agendar 0, concluídos 0.
// Três defeitos empilhados, cada um coberto abaixo:
//   a) "Agenda" (imperativo) não batia com nenhuma keyword — só "agendar";
//   b) a mensagem "Avaliação" sobrescrevia lastIntent, apagando a evidência;
//   c) a conversão era contada só se o telefone estivesse na lista de quem
//      teve intenção — com (a)/(b) quebrados, o agendamento real sumia também.
import { describe, expect, it } from "vitest";
import { detectIntent } from "./intent";
import { computeFunnel, hasScheduleIntentEvidence } from "./funnel";
import { deriveTaskState } from "./taskState";
import { derivePendingTask } from "./pendingTask";
import { opportunitiesFromPendingTasks } from "./opportunities";

const PHONE = "5514996455887";
const DAY_START = new Date("2026-09-02T03:00:00.000Z").getTime(); // 00:00 local (-03)
const DAY_END = DAY_START + 24 * 3600000;

describe("regressão: agendamento real em duas mensagens conta no funil do dia", () => {
  it("(a) a primeira mensagem real é reconhecida como intenção de agendar", () => {
    expect(detectIntent("Agenda pra amanhã!! As 9").type).toBe("schedule_appointment");
  });

  it("(b) a segunda mensagem ('Avaliação') não é de agendamento — por isso lastIntent sozinho não basta", () => {
    expect(detectIntent("Avaliação").type).toBe("general_question");
  });

  it("(b) o carimbo durável preserva a intenção mesmo com lastIntent sobrescrito", () => {
    const evidencia = hasScheduleIntentEvidence({
      lastIntent: "general_question", // sobrescrito pela msg "Avaliação"
      lastScheduleIntentAt: DAY_START + 9 * 3600000, // carimbado na 1ª msg
      contactPhoneKey: PHONE,
      from: DAY_START,
      to: DAY_END,
      phonesWithBotAppointment: new Set(),
    });
    expect(evidencia).toBe(true);
  });

  it("(c) um agendamento criado pelo bot é evidência suficiente, mesmo sem carimbo (conversas antigas)", () => {
    const evidencia = hasScheduleIntentEvidence({
      lastIntent: "general_question",
      lastScheduleIntentAt: undefined, // conversa gravada antes do campo existir
      contactPhoneKey: PHONE,
      from: DAY_START,
      to: DAY_END,
      phonesWithBotAppointment: new Set([PHONE]),
    });
    expect(evidencia).toBe(true);
  });

  it("carimbo de OUTRO dia não conta como intenção de hoje", () => {
    const evidencia = hasScheduleIntentEvidence({
      lastIntent: "general_question",
      lastScheduleIntentAt: DAY_START - 48 * 3600000,
      contactPhoneKey: PHONE,
      from: DAY_START,
      to: DAY_END,
      phonesWithBotAppointment: new Set(),
    });
    expect(evidencia).toBe(false);
  });

  it("o funil do dia reconhece intenção E conversão para este cenário", () => {
    const funnel = computeFunnel({
      atendimentos: 1,
      intencaoAgendar: 1, // via carimbo durável / agendamento do bot
      agendamentosConcluidos: 1, // create_appointment devolveu sucesso
    });
    expect(funnel.intencaoAgendar).toBe(1);
    expect(funnel.agendamentosConcluidos).toBe(1);
    expect(funnel.naoConcluidos).toBe(0);
    expect(funnel.taxaConversao).toBe(1);
  });

  it("o estado da tarefa é encerrado quando o agendamento é criado (nada fica em aberto)", () => {
    const taskAposColeta = deriveTaskState({
      existingTask: null,
      intent: detectIntent("Agenda pra amanhã!! As 9"),
      toolCalls: [{ name: "find_available_appointments", args: { date: "2026-09-03" } }],
      booked: false,
    });
    expect(taskAposColeta?.type).toBe("schedule_appointment");

    const taskAposCriar = deriveTaskState({
      existingTask: taskAposColeta,
      intent: detectIntent("Avaliação"),
      toolCalls: [{ name: "create_appointment", args: { serviceName: "Avaliação", startAt: 1 } }],
      booked: true, // operação concluída com sucesso
    });
    expect(taskAposCriar).toBeNull();
  });

  it("não vira oportunidade de agendamento abandonado depois da conversão", () => {
    const pendencia = derivePendingTask({
      intent: detectIntent("Avaliação"),
      handoffActive: false,
      task: null, // tarefa encerrada pela conversão
      operationCompleted: true,
    });
    expect(pendencia).toBeNull();

    // Sem pendência aberta, não existe oportunidade de "agendamento
    // iniciado e não concluído" para esta conversa.
    expect(opportunitiesFromPendingTasks([], new Map())).toHaveLength(0);
  });
});

describe("regressão: outras formas reais de pedir agendamento", () => {
  it.each([
    "Agenda pra amanhã!! As 9",
    "agenda aí pra mim",
    "quero um agendamento",
    "pode agendar?",
    "queria marcar",
    "marca uma consulta pra quinta",
  ])("reconhece %s", (texto) => {
    expect(detectIntent(texto).type).toBe("schedule_appointment");
  });

  it("cancelar e remarcar continuam vencendo sobre a regra de agendar", () => {
    expect(detectIntent("quero desmarcar meu horário").type).toBe("cancel_appointment");
    expect(detectIntent("preciso remarcar meu agendamento").type).toBe("reschedule_appointment");
  });
});
