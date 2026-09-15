// OT-03G-R1: a saudação/fuso NÃO pode cair silenciosamente em -180 só porque
// booking está desligado. Estes testes provam, no nível do think(), que o
// offset vem da config do estabelecimento (getScheduleConfig) mesmo com
// bookingEnabled === false, e que o mesmo instante UTC rende períodos
// diferentes por fuso.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent } from "@/types";

// 02:00 UTC — instante único para todos os casos.
//   offset -180 (Brasil): 23:00 local → noite → "boa noite"
//   offset +540 (Tóquio): 11:00 local → manhã → "bom dia"
const INSTANT = new Date("2026-09-15T02:00:00.000Z").getTime();

// Offset por estabelecimento, resolvido pela FONTE CANÔNICA (mock de
// getScheduleConfig). Nenhum estabelecimento aqui tem doc "real"; o mock
// simula o que getScheduleConfig devolveria.
const OFFSET_BY_EST: Record<string, number> = {
  brasil: -180,
  toquio: 540,
  brasil_booking: -180,
};

let lastCreateParams: { messages: { role: string; content: string }[] } | null = null;
const create = vi.fn(async (params: { messages: { role: string; content: string }[] }) => {
  lastCreateParams = params;
  return { choices: [{ message: { content: "ok", tool_calls: undefined } }] };
});

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async (establishmentId: string) => ({
    establishmentId,
    utcOffsetMinutes: OFFSET_BY_EST[establishmentId] ?? -180,
    defaultDurationMin: 30,
    slotMinutes: 30,
    days: {},
  }),
  localToEpoch: () => 0,
  assertBookable: async () => null,
}));

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [],
  runTool: async () => ({ ok: true, data: {} }),
}));

const { think } = await import("./brain");

function estWith(id: string, bookingEnabled: boolean): Establishment {
  return {
    id,
    name: "Estabelecimento",
    bot: {
      personaName: "Livia",
      tone: "acolhedora",
      bookingEnabled,
      handoffKeywords: [],
      medicalGuardrail: false,
    },
  } as unknown as Establishment;
}

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

async function systemPromptFor(est: Establishment): Promise<string> {
  lastCreateParams = null;
  await think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: "queria uma informação", at: INSTANT }],
    contactPhone: "5514999999999",
    contactName: "Cliente",
    customerProfile: null,
    task: null,
    intent,
  });
  // Cast para reabrir o tipo: o TS não enxerga que o mock de create reatribui
  // esta variável de módulo, então sem isto ele a estreita para o valor de
  // reset acima.
  const captured = lastCreateParams as { messages: { role: string; content: string }[] } | null;
  const system = captured?.messages.find((m) => m.role === "system");
  return system?.content ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(INSTANT);
});

describe("OT-03G-R1 — offset vem do estabelecimento mesmo sem booking", () => {
  it("booking=false + offset -180 (Brasil, 23:00 local) → noite / 'boa noite'", async () => {
    const prompt = await systemPromptFor(estWith("brasil", false));
    expect(prompt).toContain("Período do dia agora (horário local): noite");
    expect(prompt).toContain('use "boa noite"');
    expect(prompt).not.toContain('use "bom dia"');
  });

  it("booking=false + offset +540 (Tóquio, 11:00 local) → manhã / 'bom dia' — NÃO cai em -180", async () => {
    const prompt = await systemPromptFor(estWith("toquio", false));
    expect(prompt).toContain("Período do dia agora (horário local): manhã");
    expect(prompt).toContain('use "bom dia"');
    expect(prompt).not.toContain('use "boa noite"');
  });

  it("mesmo instante UTC, dois fusos → períodos diferentes (prova a fonte por estabelecimento)", async () => {
    const brasil = await systemPromptFor(estWith("brasil", false));
    const toquio = await systemPromptFor(estWith("toquio", false));
    expect(brasil).toContain("noite");
    expect(toquio).toContain("manhã");
    expect(brasil).not.toBe(toquio);
  });

  it("regressão booking=true + offset -180 (23:00 local) → noite (comportamento de agenda inalterado)", async () => {
    const prompt = await systemPromptFor(estWith("brasil_booking", true));
    expect(prompt).toContain("Período do dia agora (horário local): noite");
    expect(prompt).toContain('use "boa noite"');
  });
});
