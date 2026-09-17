import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logError } from "./observability";

let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  spy.mockRestore();
});

function loggedPayload(callIndex = 0): Record<string, unknown> {
  const call = spy.mock.calls[callIndex]!;
  return JSON.parse(call[1] as string);
}

describe("logError", () => {
  it("inclui categoria/operacao/timestamp e nome+mensagem do erro", () => {
    logError({ category: "agenda", operation: "create_appointment", error: new Error("conflito de horário") });
    const p = loggedPayload();
    expect(p.category).toBe("agenda");
    expect(p.operation).toBe("create_appointment");
    expect(p.errorName).toBe("Error");
    expect(p.errorMessage).toBe("conflito de horário");
    expect(typeof p.timestamp).toBe("string");
  });

  it("nunca inclui stack trace", () => {
    logError({ category: "api", operation: "x", error: new Error("y") });
    const raw = JSON.stringify(loggedPayload());
    expect(raw).not.toContain("at ");
    expect(loggedPayload().stack).toBeUndefined();
  });

  it("trunca mensagem de erro muito longa (evita vazar payload grande)", () => {
    const longMessage = "x".repeat(1000);
    logError({ category: "whatsapp_webhook", operation: "handle", error: new Error(longMessage) });
    expect((loggedPayload().errorMessage as string).length).toBe(300);
  });

  it("establishmentId/requestId so aparecem quando fornecidos", () => {
    logError({ category: "auth", operation: "x", error: new Error("y") });
    expect(loggedPayload().establishmentId).toBeUndefined();
    expect(loggedPayload().requestId).toBeUndefined();

    logError({ category: "auth", operation: "x", error: new Error("y"), establishmentId: "est_1" });
    expect(loggedPayload(1).establishmentId).toBe("est_1");
  });

  it("erro nao-Error (string/objeto lancado) nao quebra e nao vaza estrutura bruta", () => {
    logError({ category: "api", operation: "x", error: "falha crua" });
    const p = loggedPayload();
    expect(p.errorName).toBe("string");
    expect(p.errorMessage).toBe("falha crua");
  });
});
