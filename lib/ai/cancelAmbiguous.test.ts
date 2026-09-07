// Reprodução do caso real de 08/09/2026: 8 agendamentos ativos, a Livia
// pergunta "qual deles?" e o cliente responde "o das 10 hrs" — havia
// EXATAMENTE UM agendamento às 10:00 (Radiografias amanhã), mas a resposta
// foi "não consegui localizar".
//
// Causa: o prompt do estado "ambiguous" só expõe RÓTULOS ao modelo
// (cancelOutcomeSection), nunca os ids reais — então a escolha do cliente
// tinha que passar pelo loop geral do modelo, que só acerta se ele voltar a
// chamar get_customer_appointments NESTE turno para conseguir um id de
// verdade. "o das 10 hrs" falhou; "mas tenho agendamento para amanha as 10"
// funcionou, porque nessa segunda tentativa o modelo relistou a agenda.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-08T13:00:00.000Z").getTime(); // 08/09 10:00 local

const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: "ok", tool_calls: undefined } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} }),
}));

// Os 8 agendamentos reais da conversa que motivou este teste.
const AGENDA = [
  { id: "a1", serviceName: "Canal", day: "hoje", date: "2026-09-08", time: "14:00" },
  { id: "a2", serviceName: "Avaliação", day: "hoje", date: "2026-09-08", time: "16:00" },
  { id: "a3", serviceName: "Avaliação", day: "amanhã", date: "2026-09-09", time: "09:00" },
  { id: "a4", serviceName: "Radiografias odontológicas", day: "amanhã", date: "2026-09-09", time: "10:00" },
  { id: "a5", serviceName: "Limpeza", day: null, date: "2026-09-09", time: "13:00" },
  { id: "a6", serviceName: "Limpeza", day: null, date: "2026-09-09", time: "15:00" },
  { id: "a7", serviceName: "Avaliação", day: null, date: "2026-09-09", time: "16:00" },
  { id: "a8", serviceName: "Canal", day: null, date: "2026-09-14", time: "15:00" },
];

const runTool = vi.fn(async (name: string, _args?: Record<string, unknown>, _ctx?: unknown) => {
  if (name === "get_customer_appointments") return { ok: true, data: { appointments: AGENDA } };
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [],
  runTool: (...a: unknown[]) => runTool(...(a as [string, Record<string, unknown>])),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "cancel_appointment", confidence: 0.85, entities: {} };

function tarefa(): ConversationTask {
  return { type: "cancel_appointment", state: "confirm", collectedData: {}, missingData: [], updatedAt: AGORA };
}

async function clienteDiz(texto: string) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996447132",
    contactName: "niltinho",
    customerProfile: null,
    task: tarefa(),
    intent,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
});

describe("o caso real: 'o das 10 hrs' resolve na hora, sem precisar de retry", () => {
  it("acha o único agendamento às 10:00 e pede confirmação — não cancela ainda", async () => {
    const result = await clienteDiz("o das 10 hrs");

    // Ainda não cancelou (falta confirmar), mas identificou o alvo certo.
    expect(runTool).not.toHaveBeenCalledWith("cancel_appointment", expect.anything(), expect.anything());
    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("Radiografias odontológicas");
    expect(prompt).toContain("AINDA NÃO FOI CANCELADO");
  });

  it("por serviço: 'a limpeza das 15' resolve entre as duas Limpezas", async () => {
    const result = await clienteDiz("quero cancelar a limpeza das 15");
    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("Limpeza");
    expect(prompt).not.toContain("MAIS DE UM agendamento ativo");
    void result;
  });

  it("horário que bate com DOIS serviços diferentes continua ambíguo (não escolhe às cegas)", async () => {
    // 16:00 aparece em a2 (Avaliação hoje) E a7 (Avaliação 09/09) — duas
    // batidas, não uma. Não pode resolver sozinho.
    const result = await clienteDiz("cancela o das 16");
    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("MAIS DE UM agendamento ativo");
    void result;
  });

  it("sem nenhuma pista reconhecível, continua perguntando qual — nunca escolhe pela lista inteira", async () => {
    const result = await clienteDiz("cancela esse");
    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("MAIS DE UM agendamento ativo");
    void result;
  });

  it("dia + horário juntos ('amanha as 10') resolvem igual", async () => {
    await clienteDiz("mas tenho agendamento para amanha as 10");
    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("Radiografias odontológicas");
    expect(prompt).not.toContain("MAIS DE UM agendamento ativo");
  });
});
