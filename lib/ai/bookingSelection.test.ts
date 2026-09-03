// Fechamento do BUG 1: o cliente responde só "13" e o DESFECHO tem que vir
// do backend.
//
// A correção anterior (c693fb7) garantia consistência entre listar e criar,
// mas só QUANDO as ferramentas eram chamadas. Como "13" não casa com nenhuma
// regra de intenção e `tool_choice` é "auto", o modelo continuava livre para
// declarar "13:00 já foi ocupado" sem consultar nada — que foi exatamente o
// que aconteceu em Production, com a agenda vazia naquele horário.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTask, Establishment, Intent } from "@/types";

const OFFSET = -180;
const AGORA = new Date("2026-09-03T17:00:00.000Z").getTime();

let respostas: string[] = [];
const create = vi.fn(async (_params?: unknown) => ({
  choices: [{ message: { content: respostas.shift() ?? "ok", tool_calls: undefined } }],
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
  },
}));

// Estado da agenda controlado por teste.
let horarioLivre = true;
const assertBookable = vi.fn(async () => (horarioLivre ? null : "overlap"));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: async () => ({ utcOffsetMinutes: OFFSET, defaultDurationMin: 30, days: {} }),
  localToEpoch: (dateStr: string, minutos: number, offset: number) => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!) + minutos * 60000 - offset * 60000;
  },
  assertBookable: (...a: unknown[]) => assertBookable(...(a as [])),
}));

const runTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
  if (name === "create_appointment") {
    return horarioLivre
      ? { ok: true, data: { when: "04/09 às 13:00", serviceName: args.serviceName } }
      : { ok: false, error: "esse horário acabou de ser ocupado; ofereça outro", reasonCode: "overlap" };
  }
  if (name === "find_available_appointments") {
    return { ok: true, data: { date: args.date, slots: [{ time: "14:30" }, { time: "15:00" }] } };
  }
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [{ type: "function", function: { name: "create_appointment", parameters: {} } }],
  runTool: (...a: unknown[]) => runTool(...(a as [string, Record<string, unknown>])),
}));

const { think } = await import("./brain");

const est = {
  id: "demo",
  name: "Clínica",
  bot: { personaName: "Livia", tone: "acolhedora", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
} as unknown as Establishment;

const intent: Intent = { type: "general_question", confidence: 0.3, entities: {} };

// Contexto real: a Livia ofereceu horários para 04/09 e aguarda a escolha.
function tarefaAguardandoEscolha(over: Partial<ConversationTask> = {}): ConversationTask {
  return {
    type: "schedule_appointment",
    state: "offer_options",
    collectedData: { date: "2026-09-04", serviceName: "Avaliação" },
    missingData: [],
    updatedAt: AGORA,
    ...over,
  };
}

async function clienteResponde(texto: string, task: ConversationTask | null) {
  return think({
    est,
    kb: null,
    history: [{ id: "1", role: "customer", text: texto, at: AGORA }],
    contactPhone: "5514996447132",
    contactName: "Nilton",
    customerProfile: null,
    task,
    intent,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.setSystemTime(AGORA);
  respostas = [];
  horarioLivre = true;
});

describe("cenário A: 13:00 livre, cliente responde '13'", () => {
  it("o backend cria a reserva antes de qualquer texto ser gerado", async () => {
    respostas = ["Prontinho! Agendado."];

    const result = await clienteResponde("13", tarefaAguardandoEscolha());

    expect(runTool).toHaveBeenCalledWith(
      "create_appointment",
      expect.objectContaining({ serviceName: "Avaliação" }),
      expect.anything(),
    );
    expect(result.booked).toBe(true);
    expect(result.toolCalls.map((t) => t.name)).toContain("create_appointment");
  });

  it("o horário é resolvido pela data já coletada e pelo fuso do estabelecimento", async () => {
    respostas = ["Agendado."];
    await clienteResponde("13", tarefaAguardandoEscolha());

    const [, args] = runTool.mock.calls.find((c) => c[0] === "create_appointment")!;
    // 04/09/2026 13:00 local (-03) = 16:00 UTC
    expect(args.startAt).toBe(new Date("2026-09-04T16:00:00.000Z").getTime());
  });

  it("o resultado real chega ao modelo como fato consumado", async () => {
    respostas = ["Agendado."];
    await clienteResponde("13", tarefaAguardandoEscolha());

    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("RESULTADO REAL DA RESERVA");
    expect(prompt).toContain("AGENDAMENTO CRIADO");
  });

  it("se o modelo ainda assim disser 'ocupado', a resposta é corrigida pelo backend", async () => {
    respostas = ["O horário das 13:00 já foi ocupado."];

    const result = await clienteResponde("13", tarefaAguardandoEscolha());

    expect(result.reply).not.toMatch(/ocupad/i);
    expect(result.reply).toMatch(/13:00/);
    expect(result.booked).toBe(true);
    expect(result.handoff).toBe(false);
  });

  it("reconhece as formas reais de escolher horário", async () => {
    for (const texto of ["13", "13:00", "13h", "às 13", "pode ser 13"]) {
      vi.clearAllMocks();
      respostas = ["Agendado."];
      const result = await clienteResponde(texto, tarefaAguardandoEscolha());
      expect(result.booked, `"${texto}" deveria virar reserva`).toBe(true);
    }
  });
});

describe("cenário B: 13:00 foi realmente ocupado entre a oferta e a escolha", () => {
  beforeEach(() => {
    horarioLivre = false;
  });

  it("o conflito vem do backend e as alternativas são reais", async () => {
    respostas = ["Esse horário não está mais disponível. Tenho 14:30 ou 15:00."];

    const result = await clienteResponde("13", tarefaAguardandoEscolha());

    expect(result.booked).toBe(false);
    expect(runTool).toHaveBeenCalledWith("find_available_appointments", { date: "2026-09-04" }, expect.anything());

    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("NÃO pôde ser reservado");
    expect(prompt).toContain("14:30, 15:00");
    expect(prompt).toMatch(/Ofereça SOMENTE estes/i);
  });

  it("a resposta de indisponibilidade é permitida porque veio do backend", async () => {
    respostas = ["Esse horário já foi ocupado. Tenho 14:30 ou 15:00."];

    const result = await clienteResponde("13", tarefaAguardandoEscolha());

    expect(result.reply).toMatch(/14:30/);
    expect(result.handoff).toBe(false);
  });
});

describe("não existe caminho para o modelo inventar indisponibilidade", () => {
  it("sem consulta à agenda no turno, a afirmação é barrada e o modelo é forçado a consultar", async () => {
    respostas = ["O horário das 13:00 já foi ocupado.", "Consultei: temos 14:30 e 15:00."];

    // Sem tarefa pendente -> nenhuma resolução automática acontece.
    const result = await clienteResponde("13", null);

    expect(create).toHaveBeenCalledTimes(2);
    const correcao = (create.mock.calls[1]![0] as unknown as { messages: { role: string; content: string }[] }).messages.at(-1)!;
    expect(correcao.role).toBe("system");
    expect(correcao.content).toMatch(/NENHUMA consulta à agenda foi feita/i);
    expect(result.reply).not.toMatch(/já foi ocupado/i);
  });

  it("insistindo na invenção, transfere para humano em vez de mentir", async () => {
    respostas = ["Está ocupado.", "Continua ocupado."];

    const result = await clienteResponde("13", null);

    expect(result.handoff).toBe(true);
    expect(result.reply).not.toMatch(/ocupad/i);
  });
});

describe("guardas do gatilho automático", () => {
  it("não reserva quando não há tarefa de agendamento pendente", async () => {
    respostas = ["Certo!"];
    await clienteResponde("13", null);
    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
  });

  it("não reserva quando a data ainda não foi coletada", async () => {
    respostas = ["Para qual dia?"];
    await clienteResponde("13", tarefaAguardandoEscolha({ collectedData: { serviceName: "Avaliação" } }));
    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
  });

  it("não reserva quando a mensagem não é escolha de horário", async () => {
    respostas = ["Claro!"];
    await clienteResponde("pode ser na semana que vem?", tarefaAguardandoEscolha());
    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
  });

  it("sem serviço definido, checa disponibilidade no backend e pede o serviço", async () => {
    respostas = ["Qual serviço você quer?"];

    await clienteResponde("13", tarefaAguardandoEscolha({ collectedData: { date: "2026-09-04" } }));

    expect(assertBookable).toHaveBeenCalled();
    expect(runTool).not.toHaveBeenCalledWith("create_appointment", expect.anything(), expect.anything());
    const prompt = (create.mock.calls[0]![0] as unknown as { messages: { content: string }[] }).messages[0]!.content;
    expect(prompt).toContain("ESTÁ DISPONÍVEL");
  });
});
