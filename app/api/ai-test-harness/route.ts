// TEMPORÁRIO — harness de teste isolado do modelo (branch
// test/gpt-5-4-mini). NÃO faz parte do produto. Remover num commit
// separado antes de qualquer merge/PR real.
//
// Objetivo: exercitar lib/ai/brain.ts (think) e lib/ai/summarize.ts
// (summarizeConversation) com dados 100% sintéticos, sem webhook, sem
// Meta, sem WhatsApp real e sem dado de cliente/estabelecimento real.
//
// Guardas:
//  - só responde quando VERCEL_ENV === "preview" (404 em qualquer outro
//    ambiente, inclusive se esta branch for mergeada por engano);
//  - exige ?confirm=yes (higiene contra acesso acidental — não é
//    autenticação real, mas não há nada sensível atrás dela: payload
//    fixo, sem I/O de escrita esperado);
//  - payload fixo no código — nunca aceita prompt vindo do request;
//  - establishmentId sintético que não existe no Firestore
//    ("_ai_test_harness"); bookingEnabled=false desativa TODAS as
//    ferramentas de escrita de agenda (find/create/reschedule/cancel/
//    confirm_appointment — ver enabled() em lib/ai/tools.ts). As
//    ferramentas que continuam disponíveis mesmo sem booking
//    (get_business_hours, search_knowledge_base, get_customer_profile,
//    update_customer_profile, get_customer_appointments,
//    request_human_handoff) só fazem, no pior caso, LEITURA contra um
//    documento inexistente desse tenant fake — a mensagem sintética não
//    contém nenhuma preferência explícita do cliente, então não há
//    sinal para o modelo chamar update_customer_profile (a única
//    ferramenta desta lista que escreve);
//  - resposta nunca inclui token/key — só status HTTP, tipo/código/
//    mensagem de erro sanitizados, usage e nomes das tool calls.
import { NextResponse } from "next/server";
import OpenAI from "openai";
import { think } from "@/lib/ai/brain";
import { summarizeConversation } from "@/lib/ai/summarize";
import { detectIntent } from "@/lib/ai/intent";
import type { Establishment, KnowledgeBase, Message } from "@/types";

export const dynamic = "force-dynamic";

const TEST_ESTABLISHMENT_ID = "_ai_test_harness";

function resolvedModel(): string {
  return process.env.LIVIA_MODEL ?? "gpt-4o-mini";
}

// Defesa extra: nunca deixa passar nada com a forma de uma API key da
// OpenAI, mesmo que a mensagem venha da própria OpenAI (não é esperado
// que aconteça — a OpenAI nunca ecoa a key do chamador nos erros).
function scrub(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  return text.replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]");
}

interface ScenarioResult {
  scenario: string;
  status: "PASS" | "FAIL";
  model: string;
  httpStatus?: number;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  toolCalls?: string[];
  replyPreview?: string;
}

function fromApiError(err: unknown): {
  httpStatus?: number;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
} {
  const e = err as {
    status?: number;
    error?: { message?: string; type?: string; code?: string | number };
    message?: string;
  } | null;
  return {
    httpStatus: e?.status,
    errorType: e?.error?.type,
    errorCode: e?.error?.code !== undefined ? String(e.error.code) : undefined,
    errorMessage: scrub(e?.error?.message ?? e?.message ?? String(err)),
  };
}

// ---- Fixtures sintéticas (fixas — nunca vêm do request) ----
function testEstablishment(): Establishment {
  return {
    id: TEST_ESTABLISHMENT_ID,
    name: "Harness de Teste (não é um estabelecimento real)",
    type: "salao",
    ownerUid: TEST_ESTABLISHMENT_ID,
    status: "active",
    createdAt: Date.now(),
    bot: {
      personaName: "Livia",
      tone: "acolhedora e objetiva",
      bookingEnabled: false, // desativa todas as ferramentas de escrita de agenda
      handoffKeywords: ["falar com atendente", "atendente", "humano"],
      medicalGuardrail: false,
    },
  };
}

function testKnowledgeBase(): KnowledgeBase {
  return {
    establishmentId: TEST_ESTABLISHMENT_ID,
    about: "Salão de beleza fictício, usado só para teste de modelo de IA.",
    address: "Rua de Teste, 123",
    hours: "Seg-Sex 9h-18h",
    services: [{ name: "Limpeza de Pele", priceText: "R$ 120", durationText: "40 min", description: null }],
    faqs: [],
    notes: null,
    paymentMethods: "Pix, cartão",
    importantInfo: null,
    toneGuidelines: null,
    prohibitions: null,
    handoffTriggers: null,
    updatedAt: Date.now(),
  };
}

// ---- Cenário 1: chamada crua, sem tools — isola só o par model/temperature/max_tokens ----
async function runBrainNoTools(): Promise<ScenarioResult> {
  const model = resolvedModel();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const completion = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: "Você é uma atendente de teste. Responda em português, em uma frase curta." },
        { role: "user", content: "Oi, vocês têm horário disponível amanhã?" },
      ],
      temperature: 0.4,
      max_tokens: 500,
    });
    return {
      scenario: "brain_sem_tools",
      status: "PASS",
      model,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens,
      },
      toolCalls: [],
      replyPreview: completion.choices[0]?.message?.content?.slice(0, 160),
    };
  } catch (err) {
    return { scenario: "brain_sem_tools", status: "FAIL", model, ...fromApiError(err) };
  }
}

// ---- Cenário 2: think() real, com tools anexadas (function calling genuíno) ----
async function runBrainWithTools(): Promise<ScenarioResult> {
  const model = resolvedModel();
  const est = testEstablishment();
  const kb = testKnowledgeBase();
  // Pergunta sobre um serviço FORA da base de conhecimento sintética —
  // não pode ser respondida com o que já está no prompt, o que dá ao
  // modelo um motivo real para decidir chamar uma ferramenta (nenhuma
  // delas escreve, dado bookingEnabled=false), em vez de simplesmente
  // responder do que já tinha em contexto.
  const text = "Oi, vocês fazem unhas em gel também?";
  const history: Message[] = [{ id: "harness-1", role: "customer", text, at: Date.now() }];
  const intent = detectIntent(text);
  try {
    const result = await think({
      est,
      kb,
      history,
      contactPhone: "5511999990000",
      contactName: null,
      customerProfile: null,
      task: null,
      intent,
    });
    return {
      scenario: "brain_com_tools",
      status: "PASS",
      model,
      toolCalls: result.toolCalls.map((t) => t.name),
      replyPreview: result.reply.slice(0, 160),
    };
  } catch (err) {
    return { scenario: "brain_com_tools", status: "FAIL", model, ...fromApiError(err) };
  }
}

// ---- Cenário 3: summarizeConversation() real ----
async function runSummarize(): Promise<ScenarioResult> {
  const model = resolvedModel();
  const history: Message[] = [
    { id: "harness-1", role: "customer", text: "Oi, quanto custa a Limpeza de Pele?", at: Date.now() - 2000 },
    { id: "harness-2", role: "bot", text: "A Limpeza de Pele custa R$ 120, com duração de 40 minutos.", at: Date.now() - 1000 },
    { id: "harness-3", role: "customer", text: "Quero falar com um atendente humano.", at: Date.now() },
  ];
  const summary = await summarizeConversation(null, history, { kind: "handoff" });
  if (summary) {
    return { scenario: "summarize", status: "PASS", model, toolCalls: [], replyPreview: summary.slice(0, 160) };
  }
  // summarizeConversation() nunca lança por contrato — em falha ela
  // engole o erro e só loga no console do servidor, devolvendo "".
  // Refazemos a MESMA chamada aqui, fora do swallow, só pra reportar o
  // status/mensagem real da OpenAI neste harness de diagnóstico.
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: "teste de diagnóstico — resumo vazio, reproduzindo a chamada real" }],
      temperature: 0.2,
      max_tokens: 200,
    });
    return {
      scenario: "summarize",
      status: "FAIL",
      model,
      errorMessage: "summarizeConversation() devolveu vazio sem lançar exceção na chamada de diagnóstico — ver logs do servidor para o motivo exato.",
    };
  } catch (err) {
    return { scenario: "summarize", status: "FAIL", model, ...fromApiError(err) };
  }
}

export async function GET(req: Request) {
  if (process.env.VERCEL_ENV !== "preview") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const url = new URL(req.url);
  if (url.searchParams.get("confirm") !== "yes") {
    return NextResponse.json({ error: "pass ?confirm=yes" }, { status: 400 });
  }

  // Sequencial de propósito: cada cenário isolado, sem concorrência entre
  // as chamadas, pra manter o diagnóstico de cada um limpo.
  const brainNoTools = await runBrainNoTools();
  const brainWithTools = await runBrainWithTools();
  const summarize = await runSummarize();

  return NextResponse.json({
    note: "Harness temporário (test/gpt-5-4-mini) — dados 100% sintéticos, nenhum dado real de cliente/estabelecimento.",
    results: [brainNoTools, brainWithTools, summarize],
  });
}
