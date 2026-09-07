// REPRODUÇÃO do incidente de 06/09/2026, 21:20 (cliente Niltinho).
//
// A Livia listou 16:00 como livre para 07/09 e, ao receber "as 16", o backend
// respondeu "muito próximo" (too_soon). Depois, "9:3" para o mesmo dia voltou
// "fora do expediente" (closed_day). Nenhum dos dois faz sentido para 07/09
// (segunda, 09:00–18:00, leadHours 2, a ~12h de distância) — mas fazem todo
// sentido para 06/09 (domingo, dia fechado, e horários já passados).
//
// Este arquivo NÃO usa mock de agenda: roda lib/scheduling de verdade sobre o
// Firestore falso, com a MESMA configuração de produção
// (defaultScheduleConfig: 09–18, almoço 12–13, slot 30, lead 2h), no instante
// exato do incidente. O objetivo é separar duas hipóteses:
//
//   (a) o caminho determinístico calcula o startAt errado; ou
//   (b) o caminho determinístico está correto e simplesmente NÃO É ACIONADO
//       em produção (tarefa ausente ou com outra data), caindo no modelo.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

// 06/09/2026 21:20 local (-03) = 07/09 00:20 UTC. Domingo à noite.
const AGORA = new Date("2026-09-07T00:20:00.000Z").getTime();

let respostas: string[] = [];
const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: respostas.shift() ?? "ok", tool_calls: undefined } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { computeSlots, defaultScheduleConfig, listAppointments } from "@/lib/scheduling";
const { think } = await import("./brain");

const config = defaultScheduleConfig("demo");

const est = {
  id: "demo",
  name: "Clínica",
  status: "active",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

function tarefa(over: Partial<ConversationTask> = {}): ConversationTask {
  return {
    type: "schedule_appointment",
    state: "offer_options",
    collectedData: { date: "2026-09-07", serviceName: "Clareamento" },
    missingData: [],
    updatedAt: AGORA,
    ...over,
  };
}

async function clienteDiz(texto: string, task: ConversationTask | null) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996447132",
    contactName: "niltinho",
    customerProfile: null,
    task,
    intent,
  });
}

beforeEach(() => {
  fakeDb.reset?.();
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  respostas = [];
});

describe("a listagem e a criação concordam sobre 07/09 (agenda real)", () => {
  it("computeSlots oferece 16:00 e 09:30 em 07/09 — como a Livia ofereceu", () => {
    const slots = computeSlots(config, "2026-09-07", 30, [], AGORA).map((s) => s.time);

    expect(slots).toContain("16:00");
    expect(slots).toContain("09:30");
  });

  it('"as 16" reserva 07/09 16:00 — o caso que falhou em Production', async () => {
    respostas = ["Agendado!"];

    const result = await clienteDiz("as 16", tarefa());

    expect(result.booked).toBe(true);
    expect(result.reply).not.toMatch(/muito pr[óo]ximo/i);

    // Confirma pelo caminho de leitura real: existe UM agendamento, em
    // 07/09 16:00 local (-03) = 19:00 UTC.
    const dia = Date.UTC(2026, 8, 7) + 3 * 3600000;
    const criados = await listAppointments("demo", dia, dia + 24 * 3600000);
    expect(criados).toHaveLength(1);
    expect(new Date(criados[0]!.startAt).toISOString()).toBe("2026-09-07T19:00:00.000Z");
  });

  it('"as 9 e 30" reserva 07/09 09:30, sem "fora do expediente"', async () => {
    respostas = ["Agendado!"];

    const result = await clienteDiz("as 9 e 30", tarefa());

    expect(result.booked).toBe(true);
    expect(result.reply).not.toMatch(/fora do|expediente|muito pr[óo]ximo/i);
  });
});

describe("P4 — a data dita pelo cliente é decidida por código", () => {
  it('"quero terça as 14" reserva 08/09, mesmo com a tarefa apontando 07/09', async () => {
    respostas = ["Agendado!"];

    // A tarefa carrega 07/09 (a listagem anterior), mas o cliente acabou de
    // dizer "terça" — 08/09. Era este conflito que agendava no dia errado.
    const result = await clienteDiz("terça as 14", tarefa());

    expect(result.booked).toBe(true);

    const dia = Date.UTC(2026, 8, 8) + 3 * 3600000;
    const criados = await listAppointments("demo", dia, dia + 24 * 3600000);
    expect(criados).toHaveLength(1);
    // 08/09 14:00 local (-03) = 17:00 UTC.
    expect(new Date(criados[0]!.startAt).toISOString()).toBe("2026-09-08T17:00:00.000Z");
  });

  it('"dia 8 as 10" agenda às 10:00 — o "8" é dia do mês, não hora', async () => {
    respostas = ["Agendado!"];

    const result = await clienteDiz("dia 8 as 10", tarefa());

    expect(result.booked).toBe(true);
    const dia = Date.UTC(2026, 8, 8) + 3 * 3600000;
    const criados = await listAppointments("demo", dia, dia + 24 * 3600000);
    expect(criados).toHaveLength(1);
    // 08/09 10:00 local (-03) = 13:00 UTC. Se o "8" tivesse virado hora,
    // seria 11:00 UTC.
    expect(new Date(criados[0]!.startAt).toISOString()).toBe("2026-09-08T13:00:00.000Z");
  });

  it("mensagem com vários horários não vira reserva adivinhada", async () => {
    respostas = ["Qual deles?"];

    // Ambígua de propósito: duas horas citadas, nenhuma escolhida.
    const result = await clienteDiz("terça entre 14 e 15h", tarefa());

    expect(result.booked).toBe(false);
  });

  it("a data dita volta em statedDate, para o webhook gravar na tarefa", async () => {
    respostas = ["Certo!"];

    const result = await clienteDiz("quero terça feira", tarefa());

    // É isto que faz o "as 16" da PRÓXIMA mensagem usar 08/09.
    expect(result.statedDate).toBe("2026-09-08");
  });

  it("mensagem sem data não mexe na data em discussão", async () => {
    respostas = ["Certo!"];

    const result = await clienteDiz("pode ser", tarefa());

    expect(result.statedDate).toBeNull();
  });
});

describe("hipótese (b): a tarefa não chega ao caminho determinístico", () => {
  it("SEM tarefa, o backend não decide nada e o horário fica com o modelo", async () => {
    respostas = ["O horário das 16:00 está muito próximo."];

    const result = await clienteDiz("as 16", null);

    // Nada foi reservado: é exatamente o cenário em que a recusa observada
    // em Production pode aparecer, porque o startAt passa a ser problema do
    // modelo — que em Production mirou o dia de hoje (domingo, fechado).
    expect(result.booked).toBe(false);
  });

  it("com a data de HOJE na tarefa, a recusa observada se reproduz", async () => {
    // Domingo 06/09 é dia fechado na configuração real (days["0"] = null).
    respostas = ["Não deu."];

    const result = await clienteDiz("as 16", tarefa({ collectedData: { date: "2026-09-06", serviceName: "Clareamento" } }));

    expect(result.booked).toBe(false);
  });
});
