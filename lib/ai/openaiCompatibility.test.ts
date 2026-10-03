import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent, Message } from "@/types";
import {
  chatCompletionCompatibilityParams,
  requiresReasoningNone,
  requiresResponsesApiForTools,
  supportsTemperature,
  UnsupportedModelError,
} from "./openaiCompatibility";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  runTool: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [
    {
      type: "function",
      function: { name: "get_business_hours", description: "Consulta horários", parameters: {} },
    },
  ],
  runTool: (...args: unknown[]) => mocks.runTool(...args),
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: -180, defaultDurationMin: 30, days: {} }),
  localToEpoch: () => 0,
  assertBookable: async () => null,
}));

const est = {
  id: "compat-test",
  name: "Clínica",
  bot: {
    personaName: "Livia",
    tone: "acolhedora",
    bookingEnabled: false,
    handoffKeywords: [],
    medicalGuardrail: false,
  },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.5, entities: {} };
const history: Message[] = [{ id: "message-1", role: "customer", text: "Qual é o horário?", at: 1 }];

async function runThink(model: string) {
  vi.stubEnv("LIVIA_MODEL", model);
  const { think } = await import("./brain");
  return think({
    est,
    kb: null,
    history,
    contactPhone: "5514990000000",
    contactName: "Cliente",
    customerProfile: null,
    task: null,
    intent,
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.create.mockReset();
  mocks.runTool.mockReset();
  mocks.runTool.mockResolvedValue({ ok: true, data: { open: true } });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("troca de modelo por família, não por nome exato", () => {
  // A promessa é "trocar LIVIA_MODEL e pronto". Estas tiers são nomes
  // diferentes da MESMA restrição de endpoint, então todas precisam do
  // reasoning_effort "none" — antes só gpt-5.6-terra recebia, e as outras
  // levavam 400 em todo turno com tools.
  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-sol", "gpt-6-luna"])(
    "envia reasoning_effort none para %s",
    (model) => {
      expect(requiresReasoningNone(model)).toBe(true);
      expect(chatCompletionCompatibilityParams(model, 500, 0.4)).toMatchObject({
        max_completion_tokens: 500,
        reasoning_effort: "none",
      });
    },
  );

  // Modelos sem raciocínio rejeitam reasoning_effort. Um nome desconhecido cai
  // na mesma trilha: o request continua sendo o que a Lívia sempre mandou.
  it.each(["gpt-4o-mini", "gpt-4o", "modelo-futuro-desconhecido"])(
    "não envia reasoning_effort para %s",
    (model) => {
      expect(requiresReasoningNone(model)).toBe(false);
      expect(chatCompletionCompatibilityParams(model, 500, 0.4)).toEqual({
        max_completion_tokens: 500,
        temperature: 0.4,
      });
    },
  );

  // Estes aceitam só low..max: não há como mandar function tools no Chat
  // Completions. Falhar aqui, com o motivo, é melhor que um 400 do provider
  // classificado como provider_rejected — que manda toda conversa para
  // atendimento humano já na primeira tentativa.
  it.each(["gpt-6-astra", "gpt-6.1-sol"])(
    "recusa %s explicitamente em vez de deixar o provider devolver 400",
    (model) => {
      expect(requiresResponsesApiForTools(model)).toBe(true);
      expect(() => chatCompletionCompatibilityParams(model, 500, 0.4)).toThrow(UnsupportedModelError);
      expect(() => chatCompletionCompatibilityParams(model, 500, 0.4)).toThrow(/Responses API/);
    },
  );

  it("gpt-6-sol não é confundido com gpt-6.1-sol", () => {
    expect(requiresResponsesApiForTools("gpt-6-sol")).toBe(false);
    expect(requiresReasoningNone("gpt-6.1-sol")).toBe(false);
  });

  // Snapshots datados do provider continuam na mesma família.
  it("casa variantes datadas da família", () => {
    expect(requiresReasoningNone("gpt-5.6-sol-2026-06-26")).toBe(true);
    expect(requiresResponsesApiForTools("gpt-6-astra-2026-09-01")).toBe(true);
  });
});

// gpt-6-sol e gpt-6-luna mantêm o raciocínio sempre ligado por dentro e
  // rejeitam temperature em TODO nível de esforço, inclusive "none". Enviar o
  // parâmetro é 400 em toda mensagem — a mesma parada total que o
  // reasoning_effort ausente causava.
  describe("temperature por família", () => {
    it.each(["gpt-6-sol", "gpt-6-luna"])("não envia temperature para %s", (model) => {
      expect(supportsTemperature(model)).toBe(false);
      expect(chatCompletionCompatibilityParams(model, 500, 0.4)).toEqual({
        max_completion_tokens: 500,
        reasoning_effort: "none",
      });
    });

    it.each(["gpt-4o-mini", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"])(
      "envia temperature para %s",
      (model) => {
        expect(supportsTemperature(model)).toBe(true);
        expect(chatCompletionCompatibilityParams(model, 500, 0.4)).toHaveProperty("temperature", 0.4);
      },
    );
  });

describe("parâmetros compatíveis do Chat Completions", () => {
  it("configura GPT-5.6 Terra com max_completion_tokens, reasoning none e temperature", () => {
    expect(chatCompletionCompatibilityParams("gpt-5.6-terra", 500, 0.4)).toEqual({
      max_completion_tokens: 500,
      reasoning_effort: "none",
      temperature: 0.4,
    });
  });

  it("não envia reasoning_effort para gpt-4o-mini", () => {
    expect(chatCompletionCompatibilityParams("gpt-4o-mini", 500, 0.4)).toEqual({
      max_completion_tokens: 500,
      temperature: 0.4,
    });
  });

  it("preserva tools, temperatura e o tool loop com GPT-5.6 Terra", async () => {
    const modelMessages = [
      {
        content: null,
        tool_calls: [
          {
            id: "call-hours",
            function: { name: "get_business_hours", arguments: "{}" },
          },
        ],
      },
      { content: "A clínica está aberta." },
    ];
    mocks.create.mockImplementation(async () => ({ choices: [{ message: modelMessages.shift() }] }));

    const result = await runThink("gpt-5.6-terra");

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        model: "gpt-5.6-terra",
        temperature: 0.4,
        max_completion_tokens: 500,
        reasoning_effort: "none",
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: "get_business_hours" }) }),
        ]),
      }),
    );
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("max_tokens");
    expect(mocks.runTool).toHaveBeenCalledWith("get_business_hours", {}, expect.anything());
    expect(result.reply).toBe("A clínica está aberta.");
  });

  // O caminho completo da troca para a tier mais capaz da família: o tool loop
  // e os guards do brain não mudam, só os parâmetros do request.
  it("preserva tools, temperatura e o tool loop com GPT-5.6 Sol", async () => {
    const modelMessages = [
      {
        content: null,
        tool_calls: [{ id: "call-hours", function: { name: "get_business_hours", arguments: "{}" } }],
      },
      { content: "A clínica está aberta." },
    ];
    mocks.create.mockImplementation(async () => ({ choices: [{ message: modelMessages.shift() }] }));

    const result = await runThink("gpt-5.6-sol");

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        model: "gpt-5.6-sol",
        temperature: 0.4,
        max_completion_tokens: 500,
        reasoning_effort: "none",
        tools: expect.arrayContaining([
          expect.objectContaining({ function: expect.objectContaining({ name: "get_business_hours" }) }),
        ]),
      }),
    );
    expect(mocks.runTool).toHaveBeenCalledWith("get_business_hours", {}, expect.anything());
    expect(result.reply).toBe("A clínica está aberta.");
  });

  it("mantém o request do gpt-4o-mini sem reasoning_effort", async () => {
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "Resposta normal." } }] });

    const result = await runThink("gpt-4o-mini");

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_completion_tokens: 500,
      }),
    );
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("reasoning_effort");
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("max_tokens");
    expect(result.reply).toBe("Resposta normal.");
  });

  it.each([
    ["gpt-5.6-terra", "none"],
    ["gpt-4o-mini", undefined],
  ])("aplica a mesma compatibilidade ao summarize para %s", async (model, reasoningEffort) => {
    vi.stubEnv("LIVIA_MODEL", model);
    mocks.create.mockResolvedValue({ choices: [{ message: { content: "Resumo pronto." } }] });
    const { summarizeConversation } = await import("./summarize");

    const result = await summarizeConversation("Cliente", history, { kind: "booked" });

    expect(result).toBe("Resumo pronto.");
    expect(mocks.create.mock.calls[0]![0]).toEqual(
      expect.objectContaining({
        model,
        temperature: 0.2,
        max_completion_tokens: 200,
      }),
    );
    expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("max_tokens");
    if (reasoningEffort) {
      expect(mocks.create.mock.calls[0]![0]).toHaveProperty("reasoning_effort", reasoningEffort);
    } else {
      expect(mocks.create.mock.calls[0]![0]).not.toHaveProperty("reasoning_effort");
    }
  });
});
