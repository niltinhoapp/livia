// O "cérebro" da Livia: transforma a base de conhecimento do estabelecimento
// + o histórico da conversa numa resposta. A IA responde SOMENTE com base no
// que está cadastrado — se não souber, oferece transferir pra um atendente.
import OpenAI from "openai";
import type {
  Establishment,
  KnowledgeBase,
  Message,
  BotConfig,
} from "@/types";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini";

// Token especial que a IA emite quando decide passar pra humano. O webhook
// detecta, troca o status da conversa pra "human" e avisa o cliente.
export const HANDOFF_TOKEN = "[[HANDOFF]]";

function knowledgeToText(kb: KnowledgeBase | null): string {
  if (!kb) return "(Nenhuma informação cadastrada ainda.)";
  const parts: string[] = [];
  if (kb.about) parts.push(`Sobre: ${kb.about}`);
  if (kb.address) parts.push(`Endereço: ${kb.address}`);
  if (kb.hours) parts.push(`Horário de funcionamento: ${kb.hours}`);
  if (kb.services?.length) {
    const s = kb.services
      .map((x) => {
        const bits = [x.name];
        if (x.priceText) bits.push(`preço: ${x.priceText}`);
        if (x.durationText) bits.push(`duração: ${x.durationText}`);
        if (x.description) bits.push(x.description);
        return `- ${bits.join(" | ")}`;
      })
      .join("\n");
    parts.push(`Serviços:\n${s}`);
  }
  if (kb.faqs?.length) {
    const f = kb.faqs.map((x) => `P: ${x.question}\nR: ${x.answer}`).join("\n");
    parts.push(`Perguntas frequentes:\n${f}`);
  }
  if (kb.notes) parts.push(`Observações: ${kb.notes}`);
  return parts.join("\n\n");
}

function buildSystemPrompt(
  est: Establishment,
  kb: KnowledgeBase | null,
): string {
  const bot: BotConfig = est.bot;
  const persona = bot.personaName || "Livia";
  const rules: string[] = [
    `Você é ${persona}, a atendente virtual de "${est.name}".`,
    `Fale em português do Brasil, de forma ${bot.tone || "acolhedora e objetiva"}.`,
    "Responda SOMENTE com base nas informações abaixo do estabelecimento.",
    "Se a informação não estiver aqui, NÃO invente: diga que vai verificar com a equipe e ofereça transferir para um atendente.",
    "Seja breve — mensagens curtas, como numa conversa de WhatsApp. Evite textões.",
    "Nunca invente preços, horários, endereços ou disponibilidade.",
  ];
  if (bot.medicalGuardrail) {
    rules.push(
      "NUNCA dê diagnóstico, orientação médica, clínica ou de saúde. Para qualquer dúvida desse tipo, oriente a pessoa a agendar uma consulta ou falar com um profissional.",
    );
  }
  if (bot.bookingEnabled) {
    rules.push(
      "Você pode ajudar a pessoa a marcar um horário coletando: serviço desejado, dia e período de preferência. Confirme os dados antes de finalizar.",
    );
  } else {
    rules.push(
      "Você ainda não fecha agendamentos; para marcar, oriente a pessoa a falar com a equipe.",
    );
  }
  rules.push(
    `Se a pessoa pedir para falar com um humano/atendente, ou demonstrar irritação, ou pedir algo fora do seu escopo, responda de forma acolhedora e inclua o marcador ${HANDOFF_TOKEN} ao final da mensagem (o marcador não aparece para o cliente).`,
  );

  return [
    rules.join("\n"),
    "",
    "=== INFORMAÇÕES DO ESTABELECIMENTO ===",
    knowledgeToText(kb),
  ].join("\n");
}

export interface BrainResult {
  reply: string;
  handoff: boolean;
}

// Gera a resposta do bot a partir do histórico. `history` vem em ordem
// cronológica e JÁ inclui a mensagem atual do cliente como último item.
export async function think(
  est: Establishment,
  kb: KnowledgeBase | null,
  history: Message[],
): Promise<BrainResult> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(est, kb) },
    ...history.map((m) => ({
      role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    })),
  ];

  const completion = await openai.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.4,
    max_tokens: 400,
  });

  let reply = completion.choices[0]?.message?.content?.trim() ?? "";
  const handoff = reply.includes(HANDOFF_TOKEN);
  if (handoff) reply = reply.replaceAll(HANDOFF_TOKEN, "").trim();

  // Fallback defensivo: nunca devolver vazio.
  if (!reply) {
    reply =
      "Desculpa, não consegui entender agora. Quer que eu chame um atendente pra te ajudar?";
  }
  return { reply, handoff };
}
