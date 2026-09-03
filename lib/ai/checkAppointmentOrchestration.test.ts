// Regressão do segundo teste real que falhou em Production (03/09).
//
// Cliente: "Tenho consulta hj" (com Appointment real 03/09 09:00, Avaliação,
// pending). A Livia respondeu "Vou verificar a agenda... Um momento" e depois
// transferiu para humano, sem NUNCA consultar a agenda.
//
// Por que os testes anteriores não pegaram: eles testavam
// get_customer_appointments isoladamente, e ela funcionava. O que estava
// quebrado era a ORQUESTRAÇÃO — nada obrigava o cérebro a chamá-la, e
// `tool_choice` fica em "auto", então o modelo podia responder em texto puro.
// Este arquivo testa exatamente essa decisão.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-03T17:00:00.000Z").getTime(); // 03/09 14:00 local

// Resposta do modelo controlada por teste: por padrão ele "enrola", que é
// exatamente o que fez em Production.
let modelReply: string | null = "Oi! Vou verificar a agenda para confirmar sua consulta de hoje. Um momento, por favor.";
let modelToolCalls: unknown[] | undefined;

const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: modelReply, tool_calls: modelToolCalls } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} }),
}));

// A ferramenta real é substituída por um espião que devolve o Appointment
// REAL do cenário — assim o teste prova que a orquestração a CHAMOU.
type ToolResultShape = { ok: boolean; data?: unknown; error?: string };

const runTool = vi.fn(async (name: string): Promise<ToolResultShape> => {
  if (name === "get_customer_appointments") {
    return {
      ok: true,
      data: {
        today: "03/09/2026",
        appointments: [
          {
            id: "appt-real",
            serviceName: "Avaliação",
            date: "03/09/2026",
            time: "09:00",
            day: "hoje",
            durationMin: 30,
            status: "pending",
            statusMeaning: "horário reservado, aguardando confirmação do cliente",
            source: "bot",
          },
        ],
      },
    };
  }
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "get_customer_appointments", parameters: {} } }],
  runTool: (...a: unknown[]) => runTool(...(a as [string])),
}));

const { think } = await import("./brain");
const { detectIntent } = await import("./intent");

const est = {
  id: "demo",
  name: "Clínica Odonto",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

async function perguntar(texto: string) {
  const intent = detectIntent(texto);
  const result = await think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996447132",
    contactName: "Cliente",
    customerProfile: null,
    task: null,
    intent,
  });
  return { intent, result };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  modelReply = "Oi! Vou verificar a agenda para confirmar sua consulta de hoje. Um momento, por favor.";
  modelToolCalls = undefined;
});

describe('orquestração: "Tenho consulta hj" com Appointment real', () => {
  it("classifica como check_appointment (não como pedido de agendamento novo)", () => {
    expect(detectIntent("Tenho consulta hj").type).toBe("check_appointment");
  });

  it("o backend consulta a agenda mesmo que o modelo não peça a ferramenta", async () => {
    const { result } = await perguntar("Tenho consulta hj");

    expect(runTool).toHaveBeenCalledWith("get_customer_appointments", expect.anything(), expect.anything());
    expect(result.toolCalls.map((t) => t.name)).toContain("get_customer_appointments");
  });

  it("o Appointment real é entregue ao modelo no prompt", async () => {
    await perguntar("Tenho consulta hj");

    const params = create.mock.calls[0]?.[0] as unknown as {
      messages: { role: string; content: string }[];
    };
    const systemPrompt = params.messages[0]!.content;
    expect(systemPrompt).toContain("AGENDA REAL DESTE CLIENTE");
    expect(systemPrompt).toContain("Avaliação");
    expect(systemPrompt).toContain("09:00");
  });

  it("a resposta contém o horário e o serviço reais", async () => {
    const { result } = await perguntar("Tenho consulta hj");

    expect(result.reply).toContain("09:00");
    expect(result.reply).toContain("Avaliação");
  });

  it('a resposta NÃO contém "vou verificar", "aguarde" nem "um momento"', async () => {
    const { result } = await perguntar("Tenho consulta hj");

    expect(result.reply).not.toMatch(/vou verificar|aguarde|um momento|já te retorno/i);
  });

  it("não transfere para humano quando a consulta deu certo", async () => {
    const { result } = await perguntar("Tenho consulta hj");
    expect(result.handoff).toBe(false);
  });

  it("não oferece horários livres nem cria agendamento novo", async () => {
    const { result } = await perguntar("Tenho consulta hj");

    expect(runTool).not.toHaveBeenCalledWith("find_available_appointments", expect.anything(), expect.anything());
    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
    expect(result.booked).toBe(false);
  });

  it("um Appointment pending é apresentado como reservado, nunca como confirmado", async () => {
    const { result } = await perguntar("Tenho consulta hj");
    expect(result.reply).toMatch(/aguardando sua confirmação/i);
    expect(result.reply).not.toMatch(/confirmad[oa]/i);
  });

  it("se o modelo responder bem por conta própria, a resposta dele é preservada", async () => {
    modelReply = "Sim! Sua Avaliação está marcada para hoje às 09:00, aguardando sua confirmação.";
    const { result } = await perguntar("Tenho consulta hj");

    expect(result.reply).toBe(modelReply);
    expect(result.handoff).toBe(false);
  });

  it("se a consulta à agenda falhar, transfere e diz isso claramente (sem prometer voltar depois)", async () => {
    runTool.mockResolvedValueOnce({ ok: false, error: "firestore indisponível" });
    const { result } = await perguntar("Tenho consulta hj");

    expect(result.handoff).toBe(true);
    expect(result.reply).not.toMatch(/vou verificar|um momento|já te retorno/i);
  });
});

describe("variações da mesma pergunta", () => {
  it.each([
    "tenho consulta hoje",
    "Tenho consulta hj",
    "qual horário marquei?",
    "quando é minha consulta?",
    "que horas é meu horário?",
    "confirma minha consulta",
    "você marcou minha consulta?",
    "olhe a agenda pois está marcado hj as 9",
  ])("'%s' vira check_appointment e força a consulta", async (texto) => {
    expect(detectIntent(texto).type).toBe("check_appointment");

    const { result } = await perguntar(texto);
    expect(runTool).toHaveBeenCalledWith("get_customer_appointments", expect.anything(), expect.anything());
    expect(result.reply).toContain("09:00");
    expect(result.reply).not.toMatch(/vou verificar|aguarde|um momento/i);
  });

  it("pedir para marcar continua sendo agendamento, não consulta", () => {
    expect(detectIntent("quero agendar uma avaliação").type).toBe("schedule_appointment");
    expect(detectIntent("Agenda pra amanhã!! As 9").type).toBe("schedule_appointment");
  });

  it("remarcar e cancelar continuam vencendo sobre a consulta", () => {
    expect(detectIntent("quero remarcar minha consulta").type).toBe("reschedule_appointment");
    expect(detectIntent("quero cancelar minha consulta").type).toBe("cancel_appointment");
  });
});
