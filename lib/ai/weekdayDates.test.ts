// Regressão real de Production (06/09/2026, 20:32 — cliente Rejane): ela
// pediu "para terça-feira" e a Livia agendou na SEGUNDA (07/09). Depois,
// quando a cliente reclamou, ofereceu "remarcar para terça" listando de novo
// os horários de segunda (dava para ver na lista: o 10:00 tinha sumido,
// porque acabara de ser reservado naquele mesmo dia).
//
// Causa: o prompt já resolvia "hoje" e "amanhã" em data ISO (justamente
// porque o modelo errava a conta), mas o NOME do dia da semana continuava
// por conta dele. Agora as sete próximas datas vão resolvidas no prompt.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, Intent } from "@/types";

const OFFSET = -180;
// Domingo, 06/09/2026, 20:12 local (-03) = 23:12 UTC — o instante real da
// conversa que motivou este teste.
const AGORA = new Date("2026-09-06T23:12:00.000Z").getTime();

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
  localToEpoch: () => 0,
  assertBookable: async () => null,
}));

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [],
  runTool: async () => ({ ok: true, data: {} }),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

async function promptDeSistema(): Promise<string> {
  await think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: "quero agendar para terça-feira", at: AGORA }],
    contactPhone: "5514996901898",
    contactName: "Rejane",
    customerProfile: null,
    task: null,
    intent,
  });
  return (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
});

describe("datas dos dias da semana vão resolvidas no prompt", () => {
  it("terça-feira é 08/09, não 07/09 — o erro exato de Production", async () => {
    const prompt = await promptDeSistema();

    expect(prompt).toContain("terça = 2026-09-08");
    expect(prompt).not.toContain("terça = 2026-09-07");
  });

  it("hoje é domingo, então segunda é amanhã", async () => {
    const prompt = await promptDeSistema();

    expect(prompt).toContain("hoje = 2026-09-06");
    expect(prompt).toContain("amanhã = 2026-09-07");
    expect(prompt).toContain("segunda = 2026-09-07");
  });

  it("os sete dias aparecem, cada um uma única vez", async () => {
    const prompt = await promptDeSistema();

    for (const [dia, data] of [
      ["segunda", "2026-09-07"],
      ["terça", "2026-09-08"],
      ["quarta", "2026-09-09"],
      ["quinta", "2026-09-10"],
      ["sexta", "2026-09-11"],
      ["sábado", "2026-09-12"],
      ["domingo", "2026-09-13"],
    ]) {
      expect(prompt).toContain(`${dia} = ${data}`);
    }
  });

  it("no próprio dia, o nome aponta para a semana seguinte (nunca para trás)", async () => {
    // Segunda, 07/09/2026, 20:00 local — "segunda" só pode significar 14/09.
    vi.setSystemTime(new Date("2026-09-07T23:00:00.000Z").getTime());

    const prompt = await promptDeSistema();

    expect(prompt).toContain("hoje = 2026-09-07");
    expect(prompt).toContain("segunda = 2026-09-14");
  });
});
