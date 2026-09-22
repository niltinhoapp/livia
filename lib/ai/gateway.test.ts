// Prova de transparência do AI Gateway (OT-06B). Os 18 testes existentes que
// fazem vi.mock("openai") já cobrem o request completo de brain/summarize com
// LIVIA_MODEL definido. Aqui ficam só as garantias que eles não exercitam:
// default do modelo, a guarda de `tools` vazio (que saiu de brain.ts e passou
// a morar no gateway), repasse sem alteração e a semântica de erro.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent, Message } from "@/types";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [],
  runTool: async () => ({ ok: true, data: {} }),
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: -180, defaultDurationMin: 30, days: {} }),
  localToEpoch: () => 0,
  assertBookable: async () => null,
}));

const TOOL = {
  type: "function" as const,
  function: { name: "get_business_hours", description: "Consulta horários", parameters: {} },
};

const originalModel = process.env.LIVIA_MODEL;

beforeEach(() => {
  vi.resetModules();
  mocks.create.mockReset();
  mocks.create.mockResolvedValue({ choices: [{ message: { role: "assistant", content: "ok" } }] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (originalModel === undefined) delete process.env.LIVIA_MODEL;
  else process.env.LIVIA_MODEL = originalModel;
});

async function loadGateway(model?: string) {
  if (model === undefined) delete process.env.LIVIA_MODEL;
  else vi.stubEnv("LIVIA_MODEL", model);
  return import("./gateway");
}

function sentRequest(): Record<string, unknown> {
  return mocks.create.mock.calls[0]![0] as Record<string, unknown>;
}

describe("resolução do modelo", () => {
  it("usa o default gpt-4o-mini quando LIVIA_MODEL não está definido", async () => {
    const { runCompletion } = await loadGateway(undefined);
    await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest().model).toBe("gpt-4o-mini");
  });

  it("respeita LIVIA_MODEL quando definido", async () => {
    const { runCompletion } = await loadGateway("gpt-5.6-terra");
    await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest().model).toBe("gpt-5.6-terra");
  });
});

describe("purpose não altera o request", () => {
  it("reception e summary com os mesmos argumentos geram requests idênticos", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    const messages = [{ role: "user" as const, content: "oi" }];
    await runCompletion({ purpose: "reception", messages, temperature: 0.3, maxOutputTokens: 100 });
    await runCompletion({ purpose: "summary", messages, temperature: 0.3, maxOutputTokens: 100 });
    expect(mocks.create.mock.calls[0]![0]).toEqual(mocks.create.mock.calls[1]![0]);
    expect(sentRequest()).not.toHaveProperty("purpose");
  });
});

describe("parâmetros preservados", () => {
  it("reception: temperature 0.4 e max_completion_tokens 500, sem max_tokens", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest()).toEqual({ model: "gpt-4o-mini", messages: [], temperature: 0.4, max_completion_tokens: 500 });
  });

  it("summary: temperature 0.2 e max_completion_tokens 200, sem max_tokens", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    await runCompletion({ purpose: "summary", messages: [], temperature: 0.2, maxOutputTokens: 200 });
    expect(sentRequest()).toEqual({ model: "gpt-4o-mini", messages: [], temperature: 0.2, max_completion_tokens: 200 });
  });

  it("aplica os parâmetros de compatibilidade do gpt-5.6-terra", async () => {
    const { runCompletion } = await loadGateway("gpt-5.6-terra");
    await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest()).toMatchObject({ max_completion_tokens: 500, reasoning_effort: "none" });
  });

  it("nunca define tool_choice (mantém o default do provider)", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    await runCompletion({ purpose: "reception", messages: [], tools: [TOOL], temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest()).not.toHaveProperty("tool_choice");
  });
});

describe("messages e tools repassados sem alteração", () => {
  it("repassa as mesmas referências de messages e tools", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    const messages = [{ role: "user" as const, content: "qual o horário?" }];
    const tools = [TOOL];
    await runCompletion({ purpose: "reception", messages, tools, temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest().messages).toBe(messages);
    expect(sentRequest().tools).toBe(tools);
  });

  it("não envia a chave tools quando a lista está vazia", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    await runCompletion({ purpose: "reception", messages: [], tools: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(sentRequest()).not.toHaveProperty("tools");
  });

  it("não envia a chave tools quando ela é omitida", async () => {
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    await runCompletion({ purpose: "summary", messages: [], temperature: 0.2, maxOutputTokens: 200 });
    expect(sentRequest()).not.toHaveProperty("tools");
  });
});

describe("retorno", () => {
  it("devolve a message da primeira choice", async () => {
    const message = { role: "assistant", content: "resposta", tool_calls: [{ id: "c1" }] };
    mocks.create.mockResolvedValue({ choices: [{ message }] });
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    const result = await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(result).toBe(message);
  });

  it("devolve undefined quando não há choices", async () => {
    mocks.create.mockResolvedValue({ choices: [] });
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    const result = await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(result).toBeUndefined();
  });
});

describe("semântica de erro preservada", () => {
  const est = {
    id: "gateway-test",
    name: "Clínica",
    bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: false, handoffKeywords: [], medicalGuardrail: false },
  } as unknown as Establishment;
  const intent: Intent = { type: "general_question", confidence: 0.5, entities: {} };
  const history: Message[] = [{ id: "m1", role: "customer", text: "oi", at: 1 }];
  const providerError = new Error("provider indisponível");

  it("o gateway propaga o erro do provider sem tratá-lo", async () => {
    mocks.create.mockRejectedValue(providerError);
    const { runCompletion } = await loadGateway("gpt-4o-mini");
    await expect(
      runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 }),
    ).rejects.toBe(providerError);
  });

  it("brain.think continua propagando o erro do provider", async () => {
    mocks.create.mockRejectedValue(providerError);
    vi.stubEnv("LIVIA_MODEL", "gpt-4o-mini");
    const { think } = await import("./brain");
    await expect(
      think({ est, kb: null, history, contactPhone: "5514990000000", contactName: "Cliente", customerProfile: null, task: null, intent }),
    ).rejects.toBe(providerError);
  });

  it("summarize continua engolindo o erro e devolvendo string vazia", async () => {
    mocks.create.mockRejectedValue(providerError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      vi.stubEnv("LIVIA_MODEL", "gpt-4o-mini");
      const { summarizeConversation } = await import("./summarize");
      await expect(summarizeConversation("Cliente", history, { kind: "booked" })).resolves.toBe("");
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("limites de execução", () => {
  it("define timeout explícito e desativa retries automáticos do provider", async () => {
    const { AI_COMPLETION_TIMEOUT_MS, runCompletion } = await loadGateway("gpt-4o-mini");
    await runCompletion({ purpose: "reception", messages: [], temperature: 0.4, maxOutputTokens: 500 });
    expect(mocks.create.mock.calls[0]?.[1]).toEqual({ timeout: AI_COMPLETION_TIMEOUT_MS, maxRetries: 0 });
  });
});
