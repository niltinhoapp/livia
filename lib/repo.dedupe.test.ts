// Dedupe de mensagem do WhatsApp — prova de ATOMICIDADE, não só de
// "segunda chamada devolve duplicado" (isso já valia antes da correção).
//
// A propriedade que interessa: duas execuções CONCORRENTES da mesma
// mensagem não podem, as duas, adquirir o id. Se pudessem, a Lívia
// responderia duas vezes e uma ferramenta de escrita (create_appointment)
// poderia rodar duas vezes.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { alreadyProcessed } from "@/lib/repo";

const MSG = "wamid.HBgNNTUxNDk5MTIzNDU2NxUCABIYFjNBMEE";

beforeEach(() => {
  fakeDb.reset();
});

describe("CRÍTICO 2 — aquisição atômica do messageId", () => {
  it("primeira execução adquire (false = processa)", async () => {
    expect(await alreadyProcessed(MSG)).toBe(false);
  });

  it("segunda execução sequencial não adquire", async () => {
    expect(await alreadyProcessed(MSG)).toBe(false);
    expect(await alreadyProcessed(MSG)).toBe(true);
  });

  it("CONCORRÊNCIA: entre N execuções simultâneas, exatamente uma adquire", async () => {
    const resultados = await Promise.all(
      Array.from({ length: 8 }, () => alreadyProcessed(MSG)),
    );
    const adquiriram = resultados.filter((r) => r === false);
    expect(adquiriram).toHaveLength(1);
    expect(resultados.filter((r) => r === true)).toHaveLength(7);
  });

  it("CONCORRÊNCIA: quantas mensagens distintas, tantos processamentos", async () => {
    const ids = ["wamid.A", "wamid.B", "wamid.C"];
    const resultados = await Promise.all(
      [...ids, ...ids].map((id) => alreadyProcessed(id)),
    );
    expect(resultados.filter((r) => r === false)).toHaveLength(3);
  });

  it("mensagens diferentes nunca colidem entre si", async () => {
    expect(await alreadyProcessed("wamid.X")).toBe(false);
    expect(await alreadyProcessed("wamid.Y")).toBe(false);
  });

  it("falha DEPOIS da aquisição mantém a trava: a reentrega da Meta é descartada", async () => {
    // Execução 1 adquire e depois quebra no processamento (ex.: sendText
    // lança). O id continua gravado de propósito — a mensagem pode já ter
    // sido enviada ao cliente, e reprocessar duplicaria a resposta.
    expect(await alreadyProcessed(MSG)).toBe(false);
    try {
      throw new Error("falha simulada no processamento");
    } catch {
      /* o webhook loga e devolve 200 */
    }
    expect(await alreadyProcessed(MSG)).toBe(true);
  });

  it("erro de infraestrutura não é confundido com duplicado", async () => {
    const ref = fakeDb.collection("_processed_wa_messages").doc("wamid.ERR");
    const original = ref.create.bind(ref);
    vi.spyOn(fakeDb, "collection").mockReturnValueOnce({
      doc: () => ({
        create: async () => {
          throw new Error("14 UNAVAILABLE: connection reset");
        },
      }),
    } as never);

    await expect(alreadyProcessed("wamid.ERR")).rejects.toThrow("UNAVAILABLE");
    vi.restoreAllMocks();
    void original;
  });
});
