import { describe, it, expect } from "vitest";
import { isSilentAcknowledgement } from "./acknowledgement";
import type { ConversationTask, Intent, Message } from "@/types";

const general: Intent = { type: "general_question", confidence: 0.3, entities: {} };
const schedule: Intent = { type: "schedule_appointment", confidence: 0.75, entities: {} };
const cancel: Intent = { type: "cancel_appointment", confidence: 0.85, entities: {} };

const noTask: ConversationTask | null = null;
const confirmTask: ConversationTask = {
  type: "cancel_appointment",
  state: "confirm",
  collectedData: { appointmentId: "a1" },
  missingData: [],
  updatedAt: 0,
};
const offerTask: ConversationTask = {
  type: "schedule_appointment",
  state: "offer_options",
  collectedData: { date: "2026-09-15", serviceName: "Avaliação" },
  missingData: [],
  updatedAt: 0,
};
const collectTask: ConversationTask = {
  type: "schedule_appointment",
  state: "collect_date",
  collectedData: { serviceName: "Avaliação" },
  missingData: ["date"],
  updatedAt: 0,
};

const noHistory: Message[] = [];
const resolvedHistory: Message[] = [
  { id: "b1", role: "bot", text: "Seu horário foi confirmado para amanhã às 10h.", at: 1 },
];
const questionHistory: Message[] = [
  { id: "b1", role: "bot", text: "Quer que eu chame um atendente pra te ajudar?", at: 1 },
];
const offerHistory: Message[] = [
  { id: "b1", role: "bot", text: "Amanhã: 09:00, 11:00, 14:00, 16:00. Qual prefere?", at: 1 },
];

describe("A — silêncio esperado (sem ação pendente)", () => {
  it.each([
    "ok",
    "blz",
    "beleza",
    "certo",
    "entendi",
    "ta bom",
    "tá bom",
    "show",
    "perfeito",
    "👍",
    "👌",
    "🙏",
    "kkk",
    "rs",
    "hum",
    "valeu",
    "obg",
    "obrigado",
    "obrigada",
    "OK",
    "Beleza!",
    "Tá bom",
    "Entendi",
    "kkkk",
    "rsrs",
    "haha",
    "😄",
    "🤙",
    "vlw",
    "top",
    "massa",
    "maravilha",
    "combinado",
    "fechado",
  ])("'%s' sem ação pendente → silêncio", (text) => {
    expect(isSilentAcknowledgement(text, general, noTask, resolvedHistory)).toBe(true);
  });

  it("silêncio com histórico vazio (primeiro contato com emoji)", () => {
    expect(isSilentAcknowledgement("👍", general, noTask, noHistory)).toBe(true);
  });
});

describe("B — NÃO silenciar intenção real", () => {
  it.each([
    "ok, quero marcar amanhã",
    "blz, pode cancelar",
    "beleza, quero falar com atendente",
    "certo, mas qual o preço?",
    "entendi, e como funciona?",
    "obg, mas preciso de ajuda",
  ])("'%s' com conteúdo adicional → NÃO silenciar", (text) => {
    expect(isSilentAcknowledgement(text, general, noTask, resolvedHistory)).toBe(false);
  });

  it("intenção explícita de agendamento → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("ok", schedule, noTask, resolvedHistory)).toBe(false);
  });

  it("intenção explícita de cancelamento → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("blz", cancel, noTask, resolvedHistory)).toBe(false);
  });

  it("mensagem incompreensível sem ser acknowledgement → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("asdfghjkl", general, noTask, resolvedHistory)).toBe(false);
  });

  it("frase curta que não é acknowledgement → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("me ajuda", general, noTask, resolvedHistory)).toBe(false);
  });
});

describe("C — resposta a ação pendente", () => {
  it("'não' com task em confirm → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("não", general, confirmTask, questionHistory)).toBe(false);
  });

  it("'sim' com task em confirm → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("sim", general, confirmTask, questionHistory)).toBe(false);
  });

  it("'ok' com task em confirm → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("ok", general, confirmTask, questionHistory)).toBe(false);
  });

  it("'ok' com task em offer_options → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("ok", general, offerTask, offerHistory)).toBe(false);
  });

  it("'blz' com task em offer_options → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("blz", general, offerTask, offerHistory)).toBe(false);
  });

  it("última mensagem da Lívia perguntou algo → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("ok", general, noTask, questionHistory)).toBe(false);
  });

  it("'10h' com task em offer_options → NÃO silenciar (não é ack)", () => {
    expect(isSilentAcknowledgement("10h", general, offerTask, offerHistory)).toBe(false);
  });

  it("'ok' com collect_date task + statement bot → NÃO silenciar (task ativa)", () => {
    expect(isSilentAcknowledgement("ok", general, collectTask, resolvedHistory)).toBe(false);
  });

  it("'ok' com collect_service task + statement bot → NÃO silenciar (task ativa)", () => {
    const collectServiceTask: ConversationTask = {
      type: "schedule_appointment",
      state: "collect_service",
      collectedData: {},
      missingData: ["serviceName"],
      updatedAt: 0,
    };
    expect(isSilentAcknowledgement("ok", general, collectServiceTask, resolvedHistory)).toBe(false);
  });

  it("'beleza' com reschedule task em collect_date → NÃO silenciar", () => {
    const rescheduleCollect: ConversationTask = {
      type: "reschedule_appointment",
      state: "collect_date",
      collectedData: { serviceName: "Avaliação" },
      missingData: ["date"],
      updatedAt: 0,
    };
    expect(isSilentAcknowledgement("beleza", general, rescheduleCollect, resolvedHistory)).toBe(false);
  });

  it("'👍' com cancel task em confirm + statement bot → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("👍", general, confirmTask, resolvedHistory)).toBe(false);
  });

  it("QUALQUER task ativa impede silêncio, mesmo com statement bot", () => {
    const states: ConversationTask["state"][] = [
      "collect_service",
      "collect_date",
      "check_availability",
      "offer_options",
      "confirm",
      "create_appointment",
    ];
    for (const state of states) {
      const task: ConversationTask = {
        type: "schedule_appointment",
        state,
        collectedData: {},
        missingData: [],
        updatedAt: 0,
      };
      expect(isSilentAcknowledgement("ok", general, task, resolvedHistory)).toBe(false);
    }
  });
});

describe("D — robustez", () => {
  it("mensagem vazia → NÃO silenciar (não é ack, webhook decide)", () => {
    expect(isSilentAcknowledgement("", general, noTask, resolvedHistory)).toBe(false);
  });

  it("só espaços → NÃO silenciar", () => {
    expect(isSilentAcknowledgement("   ", general, noTask, resolvedHistory)).toBe(false);
  });

  it("pontuação final é tolerada", () => {
    expect(isSilentAcknowledgement("ok!", general, noTask, resolvedHistory)).toBe(true);
    expect(isSilentAcknowledgement("ok.", general, noTask, resolvedHistory)).toBe(true);
    expect(isSilentAcknowledgement("beleza!", general, noTask, resolvedHistory)).toBe(true);
  });

  it("case-insensitive", () => {
    expect(isSilentAcknowledgement("OK", general, noTask, resolvedHistory)).toBe(true);
    expect(isSilentAcknowledgement("Beleza", general, noTask, resolvedHistory)).toBe(true);
    expect(isSilentAcknowledgement("VALEU", general, noTask, resolvedHistory)).toBe(true);
  });

  it("acento-insensitive", () => {
    expect(isSilentAcknowledgement("tá bom", general, noTask, resolvedHistory)).toBe(true);
    expect(isSilentAcknowledgement("ta bom", general, noTask, resolvedHistory)).toBe(true);
  });
});
