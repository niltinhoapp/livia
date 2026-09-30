import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.OPENAI_API_KEY ??= "test-contingency"; });
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import OpenAI from "openai";
import { classifyAiFailure, LLM_CONTINGENCY_REPLY, shouldActivateLlmContingency } from "./llmContingency";
import { claimsOrderConfirmed } from "./brain";

const headers = {};

describe("classifyAiFailure — erros reais do SDK openai", () => {
  it.each([
    ["timeout do gateway (20s)", new OpenAI.APIConnectionTimeoutError(), "timeout"],
    ["408", new OpenAI.APIError(408, undefined, "timeout", headers), "timeout"],
    ["AbortSignal.timeout", Object.assign(new Error("aborted"), { name: "TimeoutError" }), "timeout"],
    ["429", new OpenAI.RateLimitError(429, undefined, "rate limit", headers), "rate_limited"],
    ["500", new OpenAI.InternalServerError(500, undefined, "boom", headers), "provider_unavailable"],
    ["503", new OpenAI.InternalServerError(503, undefined, "overloaded", headers), "provider_unavailable"],
    ["falha de conexão", new OpenAI.APIConnectionError({ message: "Connection error." }), "provider_unavailable"],
    ["ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }), "provider_unavailable"],
    ["400 (requisição inválida)", new OpenAI.BadRequestError(400, undefined, "bad", headers), "provider_rejected"],
    ["401 (credencial)", new OpenAI.AuthenticationError(401, undefined, "no key", headers), "provider_rejected"],
    ["erro de código", new TypeError("x is undefined"), "internal_error"],
    ["valor não-erro", "falhou", "internal_error"],
  ])("%s", (_label, error, kind) => {
    expect(classifyAiFailure(error)).toBe(kind);
  });
});

describe("shouldActivateLlmContingency", () => {
  it("falhas transitórias seguem o retry existente até a 3ª tentativa da mesma mensagem", () => {
    for (const kind of ["timeout", "rate_limited", "provider_unavailable", "internal_error"] as const) {
      expect(shouldActivateLlmContingency(kind, 0)).toBe(false);
      expect(shouldActivateLlmContingency(kind, 1)).toBe(false);
      expect(shouldActivateLlmContingency(kind, 2)).toBe(true);
    }
  });

  it("rejeição do provedor (4xx) não melhora repetindo: age na primeira", () => {
    expect(shouldActivateLlmContingency("provider_rejected", 0)).toBe(true);
  });
});

describe("texto de contingência", () => {
  it("não confirma pedido, agendamento, disponibilidade nem preço", () => {
    expect(claimsOrderConfirmed(LLM_CONTINGENCY_REPLY)).toBe(false);
    expect(LLM_CONTINGENCY_REPLY).not.toMatch(/confirm|agend|marcad|reserv|dispon|hor[áa]rio|R\$|pre[çc]o|pedido/i);
  });
});
