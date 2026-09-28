// F4 — Classificação de escopo + preservação do handoff.
//
// Garante que:
//   1. Perguntas completamente fora do escopo do negócio (OUT_OF_SCOPE) NÃO
//      disparam handoff — a guardrail operacional é injetada no prompt.
//   2. Perguntas sobre informações do PRÓPRIO estabelecimento que estão
//      faltando (BUSINESS_INFO_MISSING) ainda oferecem transferência.
//   3. Pedido explícito de humano (EXPLICIT_HUMAN_REQUEST) continua sendo
//      reconhecido pelas funções determinísticas.
//   4. Gatilhos configurados pelo comerciante (OPERATIONAL_HUMAN_NEEDED /
//      handoffTriggers) continuam sendo injetados no prompt.
//   5. Falha de ferramenta (TOOL_FAILURE) com agendamento continua instruindo
//      transferência no prompt.
//   6. Fluxo operacional NORMAL preservado: regras existentes não foram
//      removidas.
//
// Todos os 40 testes são determinísticos — nenhum chama a OpenAI de verdade.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { Establishment, Intent, KnowledgeBase } from "@/types";

// ── Mocks ────────────────────────────────────────────────────────────────────

let capturedMessages: OpenAI.Chat.ChatCompletionMessageParam[] | null = null;

vi.mock("@/lib/ai/gateway", () => ({
  runCompletion: vi.fn(async (input: { messages: OpenAI.Chat.ChatCompletionMessageParam[] }) => {
    capturedMessages = input.messages;
    return { content: "Ok!", tool_calls: undefined };
  }),
}));

vi.mock("@/lib/scheduling", () => ({
  getScheduleConfig: vi.fn(async (id: string) => ({
    establishmentId: id,
    utcOffsetMinutes: -180,
    defaultDurationMin: 30,
    slotMinutes: 30,
    days: {},
  })),
  localToEpoch: vi.fn(),
  assertBookable: vi.fn(),
  demoSlots: vi.fn(() => ({ kind: "demo", prospectingLeadId: null })),
  PRODUCTION_SLOTS: { kind: "production" },
}));

vi.mock("@/lib/repo", () => ({
  getCustomerProfile: vi.fn(async () => null),
  upsertCustomerProfile: vi.fn(async () => undefined),
}));

// Mock padrão: get_customer_appointments falha (padrão de segurança).
// Testes individuais podem sobrescrever via mockResolvedValueOnce.
const runToolMock = vi.fn(async (name: string) => {
  if (name === "get_customer_appointments") return { ok: false, error: "test-mock" };
  return { ok: true, data: {} };
});

vi.mock("@/lib/ai/tools", () => ({
  toolsFor: () => [],
  runTool: (...a: unknown[]) => runToolMock(...(a as [string])),
}));

const { think } = await import("./brain");

// ── Helpers ───────────────────────────────────────────────────────────────────

const INTENT: Intent = { type: "general_question", confidence: 0.3, entities: {} };

function baseEst(over: Partial<Establishment["bot"]> = {}): Establishment {
  return {
    id: "salao-test",
    name: "Salão Teste",
    type: "servicos",
    ownerUid: "owner-1",
    status: "active",
    createdAt: 0,
    bot: {
      personaName: "Lívia",
      tone: "acolhedora",
      bookingEnabled: false,
      ordersEnabled: false,
      medicalGuardrail: false,
      handoffKeywords: [],
      voiceRepliesEnabled: false,
      ...over,
    },
  } as unknown as Establishment;
}

const HISTORY = [{ id: "m1", role: "customer" as const, text: "Olá", at: Date.now() }];

async function systemPrompt(overrides: Partial<Parameters<typeof think>[0]> = {}): Promise<string> {
  capturedMessages = null;
  await think({
    est: baseEst(),
    kb: null,
    history: HISTORY,
    contactPhone: "5511999990000",
    contactName: null,
    customerProfile: null,
    task: null,
    intent: INTENT,
    ...overrides,
  });
  const msgs: OpenAI.Chat.ChatCompletionMessageParam[] = capturedMessages ?? [];
  const system = msgs.find((m) => m.role === "system");
  return String(system?.content ?? "");
}

beforeEach(() => {
  capturedMessages = null;
  vi.clearAllMocks();
});

// ── 1. OUT_OF_SCOPE — guardrail presente no contexto operacional ──────────────

describe("OUT_OF_SCOPE — guardrail no prompt operacional", () => {
  it("injeta a regra de escopo no contexto operacional", async () => {
    const p = await systemPrompt();
    expect(p).toContain("Perguntas alheias a este estabelecimento");
  });

  it("menciona 'Nobel da Paz' como exemplo de pergunta fora do escopo", async () => {
    const p = await systemPrompt();
    expect(p).toContain("Nobel da Paz");
  });

  it("menciona 'matemática' como exemplo de pergunta fora do escopo", async () => {
    const p = await systemPrompt();
    expect(p).toContain("matemática");
  });

  it("menciona 'capital de país' como exemplo de pergunta fora do escopo", async () => {
    const p = await systemPrompt();
    expect(p).toContain("capital de país");
  });

  it("instrui explicitamente NÃO usar request_human_handoff para perguntas genéricas", async () => {
    const p = await systemPrompt();
    expect(p).toContain("NÃO use request_human_handoff para perguntas genéricas");
  });

  it("instrui a dizer brevemente que não pode ajudar com o assunto", async () => {
    const p = await systemPrompt();
    expect(p).toContain("diga brevemente que não pode ajudar com esse assunto");
  });

  it("instrui a oferecer ajuda com algo relacionado ao estabelecimento", async () => {
    const p = await systemPrompt();
    expect(p).toContain("ofereça ajuda com algo relacionado ao estabelecimento");
  });

  it("guardrail out-of-scope NÃO está no contexto comercial (tem sua própria regra)", async () => {
    const p = await systemPrompt({
      conversationContext: { purpose: "commercial", source: "normal", enteredAt: 0, updatedAt: 0 },
    });
    // Contexto comercial tem "alheias ao negócio" mas sem "request_human_handoff para perguntas genéricas"
    expect(p).not.toContain("NÃO use request_human_handoff para perguntas genéricas");
  });

  it("guardrail out-of-scope NÃO está no contexto de auditoria", async () => {
    const p = await systemPrompt({
      conversationContext: { purpose: "audit", source: "audit_calculator", enteredAt: 0, updatedAt: 0 },
    });
    expect(p).not.toContain("NÃO use request_human_handoff para perguntas genéricas");
  });

  it("guardrail out-of-scope aparece antes da regra de tool failure (verificar depois)", async () => {
    const p = await systemPrompt();
    const posGuardrail = p.indexOf("NÃO use request_human_handoff para perguntas genéricas");
    const posVerificar = p.indexOf("NUNCA diga que vai verificar depois");
    expect(posGuardrail).toBeGreaterThan(-1);
    expect(posVerificar).toBeGreaterThan(-1);
    expect(posGuardrail).toBeLessThan(posVerificar);
  });
});

// ── 2. BUSINESS_INFO_MISSING — regra de handoff por dados faltantes preservada ─

describe("BUSINESS_INFO_MISSING — handoff por dados faltantes preservado", () => {
  it("regra de missing-info menciona 'deste estabelecimento'", async () => {
    const p = await systemPrompt();
    expect(p).toContain("deste estabelecimento");
  });

  it("regra de missing-info ainda diz 'ofereça transferir para um atendente'", async () => {
    const p = await systemPrompt();
    expect(p).toContain("ofereça transferir para um atendente");
  });

  it("regra de missing-info cita exemplos: preço, horário, endereço, serviços", async () => {
    const p = await systemPrompt();
    expect(p).toContain("preço, horário, endereço, serviços");
  });

  it("trustPolicy injeta diretiva específica para ask_price sem preços cadastrados", async () => {
    const p = await systemPrompt({
      intent: { type: "ask_price", confidence: 0.7, entities: {} },
      kb: { services: [], faqs: [] } as unknown as KnowledgeBase,
    });
    expect(p).toContain("NENHUM preço está cadastrado");
  });

  it("trustPolicy injeta diretiva específica para ask_hours sem horário cadastrado", async () => {
    const p = await systemPrompt({
      intent: { type: "ask_hours", confidence: 0.7, entities: {} },
      kb: null,
    });
    expect(p).toContain("NENHUM horário está cadastrado");
  });

  it("trustPolicy injeta diretiva específica para ask_address sem endereço cadastrado", async () => {
    const p = await systemPrompt({
      intent: { type: "ask_address", confidence: 0.7, entities: {} },
      kb: null,
    });
    expect(p).toContain("NENHUM endereço está cadastrado");
  });

  it("trustPolicy NÃO injeta diretiva para general_question", async () => {
    const p = await systemPrompt({
      intent: { type: "general_question", confidence: 0.3, entities: {} },
      kb: null,
    });
    expect(p).not.toContain("ATENÇÃO PARA ESTA RESPOSTA");
  });

  it("trustPolicy NÃO injeta diretiva para ask_price quando ordersEnabled=true", async () => {
    const p = await systemPrompt({
      est: baseEst({ ordersEnabled: true }),
      intent: { type: "ask_price", confidence: 0.7, entities: {} },
      kb: null,
      capabilities: {
        agenda_read: false,
        agenda_mutate: false,
        catalog_read: false,
        order_read: true,
        order_mutate: false,
        customer_profile_read: true,
        customer_profile_mutate: false,
        human_handoff: true,
        commercial_guidance: false,
        demo_execution: false,
      },
    });
    expect(p).not.toContain("NENHUM preço está cadastrado");
  });
});

// ── 3. EXPLICIT_HUMAN_REQUEST — reconhecimento preservado ────────────────────

describe("EXPLICIT_HUMAN_REQUEST — regra de handoff explícito no prompt", () => {
  it("prompt contém instrução para usar request_human_handoff quando cliente pede humano", async () => {
    const p = await systemPrompt();
    expect(p).toContain("request_human_handoff");
  });

  it("regra menciona 'pedir um humano/atendente' como gatilho de handoff", async () => {
    const p = await systemPrompt();
    expect(p).toContain("pedir um humano/atendente");
  });

  it("regra menciona 'demonstrar irritação' como gatilho de handoff", async () => {
    const p = await systemPrompt();
    expect(p).toContain("demonstrar irritação");
  });

  it("readHumanIntent reconhece 'falar com atendente'", async () => {
    const { readHumanIntent } = await import("./humanRequest");
    expect(readHumanIntent("quero falar com atendente")).toBe("asks");
  });

  it("readHumanIntent reconhece 'quero um humano'", async () => {
    const { readHumanIntent } = await import("./humanRequest");
    expect(readHumanIntent("quero um humano aqui")).toBe("asks");
  });
});

// ── 4. OPERATIONAL_HUMAN_NEEDED — handoffTriggers configurados ───────────────

describe("OPERATIONAL_HUMAN_NEEDED — gatilhos configurados pelo comerciante", () => {
  it("kb.handoffTriggers é injetado no prompt quando presente", async () => {
    const p = await systemPrompt({
      kb: { handoffTriggers: "Reclamação de serviço ou solicitação de reembolso" } as unknown as KnowledgeBase,
    });
    expect(p).toContain("Reclamação de serviço ou solicitação de reembolso");
  });

  it("kb.handoffTriggers usa HANDOFF_TOKEN na instrução injetada", async () => {
    const p = await systemPrompt({
      kb: { handoffTriggers: "Caso o cliente reclamar" } as unknown as KnowledgeBase,
    });
    expect(p).toContain("[[HANDOFF]]");
  });

  it("texto configurado em handoffTriggers é preservado integralmente no prompt", async () => {
    const trigger = "Quando perguntarem sobre garantia ou devolução";
    const p = await systemPrompt({
      kb: { handoffTriggers: trigger } as unknown as KnowledgeBase,
    });
    expect(p).toContain(trigger);
  });

  it("handoffTriggers NÃO é injetado quando kb é null", async () => {
    const p = await systemPrompt({ kb: null });
    expect(p).not.toContain("O estabelecimento pediu para transferir");
  });

  it("handoffTriggers NÃO aparece no contexto comercial (mayPresentLivia=true não usa knowledgeGuidanceToText)", async () => {
    const p = await systemPrompt({
      conversationContext: { purpose: "commercial", source: "normal", enteredAt: 0, updatedAt: 0 },
      kb: { handoffTriggers: "Quando reclamar de preco" } as unknown as KnowledgeBase,
    });
    expect(p).not.toContain("O estabelecimento pediu para transferir");
  });
});

// ── 5. TOOL_FAILURE — falha de consulta à agenda ────────────────────────────

describe("TOOL_FAILURE — falha de consulta à agenda", () => {
  it("falha na consulta injeta 'A consulta à agenda FALHOU'", async () => {
    const p = await systemPrompt({
      intent: { type: "check_appointment", confidence: 0.85, entities: {} },
      // @ts-expect-error — simulando appointmentLookup via opção interna passada ao think
      appointmentLookup: { ok: false },
    });
    // A mensagem de falha é construída dentro de buildSystemPrompt
    expect(p).toContain("FALHOU");
  });

  it("falha na consulta instrui a transferir para atendente", async () => {
    const p = await systemPrompt({
      intent: { type: "check_appointment", confidence: 0.85, entities: {} },
      // @ts-expect-error
      appointmentLookup: { ok: false },
    });
    expect(p).toContain("transfira para um atendente");
  });

  it("falha na consulta NÃO remove o guardrail out-of-scope do prompt", async () => {
    const p = await systemPrompt({
      intent: { type: "check_appointment", confidence: 0.85, entities: {} },
      // @ts-expect-error
      appointmentLookup: { ok: false },
    });
    expect(p).toContain("NÃO use request_human_handoff para perguntas genéricas");
  });

  it("sucesso na consulta injeta dados reais no prompt", async () => {
    runToolMock.mockResolvedValueOnce({ ok: true, data: { appointments: [{ id: "ap1", serviceName: "Corte" }] } });
    const p = await systemPrompt({
      intent: { type: "check_appointment", confidence: 0.85, entities: {} },
    });
    expect(p).toContain("Corte");
  });

  it("sucesso na consulta inclui instrução 'Responda AGORA com base neles'", async () => {
    runToolMock.mockResolvedValueOnce({ ok: true, data: { appointments: [] } });
    const p = await systemPrompt({
      intent: { type: "check_appointment", confidence: 0.85, entities: {} },
    });
    expect(p).toContain("Responda AGORA com base neles");
  });

  it("sucesso na consulta NÃO remove o guardrail out-of-scope do prompt", async () => {
    runToolMock.mockResolvedValueOnce({ ok: true, data: { appointments: [] } });
    const p = await systemPrompt({
      intent: { type: "check_appointment", confidence: 0.85, entities: {} },
    });
    expect(p).toContain("NÃO use request_human_handoff para perguntas genéricas");
  });
});

// ── 6. NORMAL — fluxo operacional regular preservado ────────────────────────

describe("NORMAL — fluxo operacional preservado", () => {
  it("nome do estabelecimento aparece no prompt", async () => {
    const p = await systemPrompt({ est: baseEst() });
    expect(p).toContain("Salão Teste");
  });

  it("seção de informações do estabelecimento está presente", async () => {
    const p = await systemPrompt();
    expect(p).toContain("INFORMAÇÕES DO ESTABELECIMENTO");
  });

  it("regra 'NUNCA diga que vai verificar depois' (tool-failure guard) está preservada", async () => {
    const p = await systemPrompt();
    expect(p).toContain("NUNCA diga que vai verificar depois");
  });

  it("regra de HANDOFF_TOKEN [[HANDOFF]] ainda está no prompt", async () => {
    const p = await systemPrompt();
    expect(p).toContain("[[HANDOFF]]");
  });

  it("medicalGuardrail é injetado quando ativado", async () => {
    const p = await systemPrompt({ est: baseEst({ medicalGuardrail: true }) });
    expect(p).toContain("NUNCA dê diagnóstico");
  });

  it("guardrail out-of-scope NÃO remove a regra 'Nunca invente preços'", async () => {
    const p = await systemPrompt();
    expect(p).toContain("Nunca invente preços, horários, endereços ou disponibilidade");
  });
});
