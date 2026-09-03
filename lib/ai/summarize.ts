// Resumo automático de conversa — Fase 2 de docs/ORDEM-IMPLEMENTACAO-INTELIGENCIA.md.
//
// Chamado SÓ nos momentos que o plano define como relevantes (handoff ou
// agendamento concluído) — nunca a cada mensagem. É uma chamada de IA
// separada e deliberadamente pequena: poucas mensagens de contexto, poucos
// tokens de saída, modelo padrão (mesmo MODEL do brain.ts, sem motivo pra
// usar um mais caro aqui).
import OpenAI from "openai";
import type { Message } from "@/types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini";

// Quantas mensagens recentes entram no resumo. Não é "o histórico inteiro"
// de propósito — o resumo é sobre o desfecho da interação atual, não um
// arquivo completo da conversa.
const SUMMARY_HISTORY_WINDOW = 12;

export interface SummaryReason {
  kind: "handoff" | "booked";
}

// Gera um resumo curto e estruturado (poucas linhas, formato livre orientado
// pelo prompt) a partir das últimas mensagens. Nunca lança: falha de resumo
// não pode derrubar o atendimento — quem chama decide o que fazer com string
// vazia (hoje: não grava).
export async function summarizeConversation(
  contactName: string | null,
  history: Message[],
  reason: SummaryReason,
): Promise<string> {
  const recent = history.slice(-SUMMARY_HISTORY_WINDOW);
  if (recent.length === 0) return "";

  const transcript = recent
    .map((m) => `${m.role === "customer" ? "Cliente" : m.role === "agent" ? "Atendente" : "Livia"}: ${m.text}`)
    .join("\n");

  const instruction =
    reason.kind === "handoff"
      ? "A conversa está sendo transferida para um atendente humano. Resuma o que o atendente precisa saber para continuar sem reler tudo."
      : "Um agendamento acabou de ser concluído nesta conversa. Resuma o que foi combinado.";

  const prompt = [
    `Cliente: ${contactName ?? "(nome não informado)"}`,
    instruction,
    "Responda em 3 a 5 linhas curtas, formato:",
    "Intenção: ...",
    "Detalhes relevantes: ...",
    "Pendência (se houver): ...",
    "Nunca invente informação que não está na conversa abaixo.",
    "",
    "=== CONVERSA ===",
    transcript,
  ].join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 200,
    });
    return completion.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.error("[livia summarize] falha ao gerar resumo:", err);
    return "";
  }
}
