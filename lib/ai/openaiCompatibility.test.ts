import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent, Message } from "@/types";
import { chatCompletionCompatibilityParams } from "./openaiCompatibility";

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

describe("parâmetros compatíveis do Chat Completions", () => {
  it("configura GPT-5.6 Terra com max_completion_tokens e reasoning none", () => {
    expect(chatCompletionCompatibilityParams("gpt-5.6-terra", 500)).toEqual({
      max_completion_tokens: 500,
      reasoning_effort: "none",
    });
  });

  it("não envia reasoning_effort para gpt-4o-mini", () => {
    expect(chatCompletionCompatibilityParams("gpt-4o-mini", 500)).toEqual({
      max_completion_tokens: 500,
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
