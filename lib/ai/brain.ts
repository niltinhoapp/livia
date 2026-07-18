// O "cérebro" da Livia: transforma a base de conhecimento + o histórico numa
// resposta. Com booking habilitado, a IA ganha "ferramentas" (function calling)
// para consultar horários livres e criar agendamentos sozinha, durante a
// conversa — sempre com o horário vindo da disponibilidade real (sem inventar).
import OpenAI from "openai";
import type { Establishment, KnowledgeBase, Message } from "@/types";
import {
  getScheduleConfig,
  listAppointments,
  computeSlots,
  createAppointment,
  localToEpoch,
} from "@/lib/scheduling";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini";

export const HANDOFF_TOKEN = "[[HANDOFF]]";

function knowledgeToText(kb: KnowledgeBase | null): string {
  if (!kb) return "(Nenhuma informação cadastrada ainda.)";
  const parts: string[] = [];
  if (kb.about) parts.push(`Sobre: ${kb.about}`);
  if (kb.address) parts.push(`Endereço: ${kb.address}`);
  if (kb.hours) parts.push(`Horário de funcionamento: ${kb.hours}`);
  if (kb.services?.length) {
    parts.push(
      "Serviços:\n" +
        kb.services
          .map((x) => {
            const bits = [x.name];
            if (x.priceText) bits.push(`preço: ${x.priceText}`);
            if (x.durationText) bits.push(`duração: ${x.durationText}`);
            if (x.description) bits.push(x.description);
            return `- ${bits.join(" | ")}`;
          })
          .join("\n"),
    );
  }
  if (kb.faqs?.length) {
    parts.push(
      "Perguntas frequentes:\n" +
        kb.faqs.map((x) => `P: ${x.question}\nR: ${x.answer}`).join("\n"),
    );
  }
  if (kb.notes) parts.push(`Observações: ${kb.notes}`);
  return parts.join("\n\n");
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function nowLocal(offsetMin: number): { dateStr: string; human: string } {
  const d = new Date(Date.now() + offsetMin * 60000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  return {
    dateStr: `${y}-${mo}-${da}`,
    human: `Hoje é ${WEEKDAYS[d.getUTCDay()]}, ${da}/${mo}/${y}, ${hh}:${mi} (horário local).`,
  };
}

function buildSystemPrompt(est: Establishment, kb: KnowledgeBase | null, nowHuman: string): string {
  const bot = est.bot;
  const persona = bot.personaName || "Livia";
  const rules: string[] = [
    `Você é ${persona}, a atendente virtual de "${est.name}".`,
    `Fale em português do Brasil, de forma ${bot.tone || "acolhedora e objetiva"}.`,
    "Responda SOMENTE com base nas informações do estabelecimento abaixo.",
    "Se a informação não estiver aqui, NÃO invente: diga que vai verificar com a equipe e ofereça transferir para um atendente.",
    "Seja breve — mensagens curtas, como numa conversa de WhatsApp.",
    "Nunca invente preços, horários, endereços ou disponibilidade.",
    nowHuman,
  ];
  if (bot.medicalGuardrail) {
    rules.push(
      "NUNCA dê diagnóstico ou orientação médica/clínica/de saúde. Para dúvidas assim, oriente a agendar uma consulta ou falar com um profissional.",
    );
  }
  if (bot.bookingEnabled) {
    rules.push(
      "Você PODE agendar. Regras do agendamento:",
      "- Descubra o serviço desejado e o dia de preferência.",
      "- SEMPRE use a ferramenta check_availability para ver horários livres reais antes de oferecer horários. Nunca chute horários.",
      "- Ofereça algumas opções de horário ao cliente.",
      "- Só depois que o cliente escolher e confirmar, use create_appointment com o startAt exato do horário escolhido (o valor vem de check_availability).",
      "- Após criar, confirme os detalhes (serviço, dia e hora) em uma frase curta.",
    );
  } else {
    rules.push("Você ainda não fecha agendamentos; para marcar, oriente a pessoa a falar com a equipe.");
  }
  rules.push(
    `Se a pessoa pedir um humano/atendente, demonstrar irritação, ou pedir algo fora do seu escopo, responda com acolhimento e inclua o marcador ${HANDOFF_TOKEN} ao final (ele não aparece para o cliente).`,
  );
  return [rules.join("\n"), "", "=== INFORMAÇÕES DO ESTABELECIMENTO ===", knowledgeToText(kb)].join("\n");
}

// ---- Ferramentas expostas à IA (só quando bookingEnabled) ----
const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description: "Retorna os horários livres reais de um dia. Use antes de oferecer qualquer horário.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Data no formato YYYY-MM-DD" },
          durationMin: { type: "number", description: "Duração em minutos (opcional; usa o padrão do estabelecimento)" },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_appointment",
      description: "Cria o agendamento após o cliente escolher e confirmar um horário.",
      parameters: {
        type: "object",
        properties: {
          serviceName: { type: "string" },
          startAt: { type: "number", description: "epoch em ms de um horário retornado por check_availability" },
          durationMin: { type: "number" },
          contactName: { type: "string", description: "nome do cliente, se souber" },
        },
        required: ["serviceName", "startAt"],
      },
    },
  },
];

export interface BrainInput {
  est: Establishment;
  kb: KnowledgeBase | null;
  history: Message[]; // ordem cronológica, já com a mensagem atual do cliente
  contactPhone: string;
  contactName: string | null;
}

export interface BrainResult {
  reply: string;
  handoff: boolean;
  booked: boolean;
}

export async function think(input: BrainInput): Promise<BrainResult> {
  const { est, kb, history, contactPhone, contactName } = input;
  const booking = est.bot.bookingEnabled;

  // Offset (para contexto de data e para as ferramentas). Sem booking, evita
  // o custo de ler a config.
  const config = booking ? await getScheduleConfig(est.id) : null;
  const offset = config?.utcOffsetMinutes ?? -180;
  const now = nowLocal(offset);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(est, kb, now.human) },
    ...history.map((m) => ({
      role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    })),
  ];

  let booked = false;

  // Loop de ferramentas (máx. algumas iterações pra não travar).
  for (let i = 0; i < 4; i++) {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 500,
      ...(booking ? { tools: TOOLS } : {}),
    });
    const msg = completion.choices[0]?.message;
    if (!msg) break;

    if (booking && msg.tool_calls?.length) {
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      for (const tc of msg.tool_calls) {
        let result: unknown;
        try {
          const args = JSON.parse(tc.function.arguments || "{}");
          if (tc.function.name === "check_availability") {
            result = await runCheckAvailability(est, config!, args);
          } else if (tc.function.name === "create_appointment") {
            const r = await runCreateAppointment(est, config!, args, contactPhone, contactName, offset);
            if (r.ok) booked = true;
            result = r;
          } else {
            result = { error: "ferramenta desconhecida" };
          }
        } catch (err) {
          result = { error: String(err) };
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue; // volta ao modelo com os resultados
    }

    let reply = msg.content?.trim() ?? "";
    const handoff = reply.includes(HANDOFF_TOKEN);
    if (handoff) reply = reply.replaceAll(HANDOFF_TOKEN, "").trim();
    if (!reply) reply = "Desculpa, não consegui entender agora. Quer que eu chame um atendente pra te ajudar?";
    return { reply, handoff, booked };
  }

  return {
    reply: "Deixa eu confirmar isso com a equipe e já te retorno, tudo bem?",
    handoff: false,
    booked,
  };
}

// ---- Executores das ferramentas ----
async function runCheckAvailability(
  est: Establishment,
  config: NonNullable<Awaited<ReturnType<typeof getScheduleConfig>>>,
  args: { date?: string; durationMin?: number },
): Promise<unknown> {
  if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
    return { error: "date inválida (use YYYY-MM-DD)" };
  }
  const duration = args.durationMin ?? config.defaultDurationMin;
  const dayStart = localToEpoch(args.date, 0, config.utcOffsetMinutes);
  const existing = await listAppointments(est.id, dayStart, dayStart + 24 * 3600000);
  const slots = computeSlots(config, args.date, duration, existing).slice(0, 12);
  if (slots.length === 0) return { date: args.date, slots: [], note: "Sem horários livres neste dia." };
  return { date: args.date, slots }; // cada slot tem { time, startAt }
}

async function runCreateAppointment(
  est: Establishment,
  config: NonNullable<Awaited<ReturnType<typeof getScheduleConfig>>>,
  args: { serviceName?: string; startAt?: number; durationMin?: number; contactName?: string },
  contactPhone: string,
  contactName: string | null,
  offset: number,
): Promise<{ ok: boolean; error?: string; when?: string }> {
  if (!args.serviceName || typeof args.startAt !== "number") {
    return { ok: false, error: "serviceName e startAt são obrigatórios" };
  }
  const duration = args.durationMin ?? config.defaultDurationMin;

  // Revalida conflito (o cliente pode ter demorado a confirmar).
  const existing = await listAppointments(est.id, args.startAt - 24 * 3600000, args.startAt + 24 * 3600000);
  const clash = existing.some(
    (a) =>
      a.status !== "cancelled" &&
      a.status !== "no_show" &&
      args.startAt! < a.startAt + a.durationMin * 60000 &&
      a.startAt < args.startAt! + duration * 60000,
  );
  if (clash) return { ok: false, error: "esse horário acabou de ser ocupado; ofereça outro" };

  await createAppointment(est.id, {
    contactPhone,
    contactName: args.contactName ?? contactName,
    serviceName: args.serviceName,
    startAt: args.startAt,
    durationMin: duration,
    source: "bot",
  });
  const d = new Date(args.startAt + offset * 60000);
  const when = `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} às ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return { ok: true, when };
}
