import { afterEach, describe, expect, it } from "vitest";
import { currentTraceId, runWithTrace, setTraceSink, traceEvent, traceIdFor } from "./pipelineTrace";

let lines: string[] = [];
const events = () => lines.map((line) => JSON.parse(line.replace(/^\[trace\] /, "")) as Record<string, unknown>);

afterEach(() => {
  setTraceSink(null);
  lines = [];
});

describe("pipelineTrace", () => {
  it("correlaciona os eventos de uma mensagem por traceId estável, com sequência e contexto", async () => {
    setTraceSink((line) => lines.push(line));
    await runWithTrace({ messageId: "wamid.ABC", establishmentId: "est-1", attempt: 2 }, async () => {
      traceEvent("message_received", { kind: "text" });
      await Promise.resolve();
      traceEvent("processing_completed", { outcome: "processed" });
    });

    const [first, second] = events();
    expect(first).toMatchObject({ traceId: traceIdFor("wamid.ABC"), seq: 1, event: "message_received", establishmentId: "est-1", attempt: 2, kind: "text" });
    expect(second).toMatchObject({ traceId: first!.traceId, seq: 2, event: "processing_completed" });
    expect(traceIdFor("wamid.ABC")).toMatch(/^[0-9a-f]{16}$/);
    // O traceId não expõe o wamid.
    expect(lines.join("\n")).not.toContain("wamid.ABC");
  });

  it("nunca registra texto, telefone, nome, prompt ou token, mesmo se passados por engano", async () => {
    setTraceSink((line) => lines.push(line));
    await runWithTrace({ messageId: "wamid.X" }, async () => {
      traceEvent("context_built", {
        text: "quero marcar amanhã", customerText: "segredo", phone: "5511999990000", contactName: "Ana",
        prompt: "SYSTEM...", token: "EAAB...", body: "x", content: "y", message: "z",
        historyCount: 3, tool: "list_menu", reason: "a".repeat(200),
      });
    });
    const [event] = events();
    expect(event).toMatchObject({ historyCount: 3, tool: "list_menu" });
    for (const key of ["text", "customerText", "phone", "contactName", "prompt", "token", "body", "content", "message"]) {
      expect(event).not.toHaveProperty(key);
    }
    expect(String(event!.reason)).toHaveLength(80);
    expect(lines.join("\n")).not.toMatch(/quero marcar|5511999990000|Ana|EAAB/);
  });

  it("fora de um trace não emite nada e não lança", () => {
    setTraceSink((line) => lines.push(line));
    expect(() => traceEvent("message_sent", { delivered: true })).not.toThrow();
    expect(lines).toEqual([]);
    expect(currentTraceId()).toBeNull();
  });

  it("fail-open: destino de log quebrado não interrompe quem chama", async () => {
    setTraceSink(() => { throw new Error("log sink down"); });
    const result = await runWithTrace({ messageId: "wamid.Y" }, async () => {
      traceEvent("llm_requested", { round: 1 });
      return "processado";
    });
    expect(result).toBe("processado");
  });

  it("fail-open: montar os dados (campo ausente num documento antigo) não lança para quem chama", async () => {
    setTraceSink((line) => lines.push(line));
    const task = { type: "schedule_appointment" } as { type: string; missingData?: string[] };
    await runWithTrace({ messageId: "wamid.Z" }, async () => {
      expect(() => traceEvent("task_state", () => ({ missingCount: task.missingData!.length }))).not.toThrow();
      traceEvent("task_state", () => ({ task: task.type }));
    });
    expect(events()).toEqual([expect.objectContaining({ event: "task_state", task: "schedule_appointment" })]);
  });

  it("traces concorrentes não se misturam", async () => {
    setTraceSink((line) => lines.push(line));
    await Promise.all(["wamid.A", "wamid.B"].map((id) => runWithTrace({ messageId: id }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      traceEvent("message_received");
      expect(currentTraceId()).toBe(traceIdFor(id));
    })));
    expect(new Set(events().map((e) => e.traceId))).toEqual(new Set([traceIdFor("wamid.A"), traceIdFor("wamid.B")]));
    expect(events().every((e) => e.seq === 1)).toBe(true);
  });
});
