// O "cérebro" da Livia: transforma a base de conhecimento + o histórico numa
// resposta. Com booking habilitado, a IA ganha "ferramentas" (function calling)
// para consultar horários livres e criar agendamentos sozinha, durante a
// conversa — sempre com o horário vindo da disponibilidade real (sem inventar).
import OpenAI from "openai";
import type { Establishment, KnowledgeBase, Message, CustomerProfile, ConversationTask, Intent } from "@/types";
import { getScheduleConfig } from "@/lib/scheduling";
import type { ToolCallRecord, ToolName } from "@/lib/ai/taskState";
import { toolsFor, runTool, type ToolContext } from "@/lib/ai/tools";
import { evaluateTrust } from "@/lib/ai/trustPolicy";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.LIVIA_MODEL ?? "gpt-4o-mini";

export const HANDOFF_TOKEN = "[[HANDOFF]]";

// Informações FACTUAIS do negócio — o que a Livia pode falar sobre o
// estabelecimento (serviços, preços, pagamento, regras). Separado de
// knowledgeGuidanceToText (que é sobre COMO falar) para o prompt deixar
// claro pra IA a diferença entre "dado que existe" e "orientação de
// comportamento".
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
  if (kb.paymentMethods) parts.push(`Formas de pagamento: ${kb.paymentMethods}`);
  if (kb.importantInfo) parts.push(`Informações importantes para o cliente: ${kb.importantInfo}`);
  if (kb.faqs?.length) {
    parts.push(
      "Perguntas frequentes:\n" +
        kb.faqs.map((x) => `P: ${x.question}\nR: ${x.answer}`).join("\n"),
    );
  }
  if (kb.notes) parts.push(`Observações: ${kb.notes}`);
  if (parts.length === 0) return "(Nenhuma informação cadastrada ainda.)";
  return parts.join("\n\n");
}

// Orientação de COMPORTAMENTO cadastrada pelo comerciante em "Ensine a
// Livia" — como falar, o que nunca fazer, quando chamar humano. Isto entra
// nas regras do prompt (não na seção de "informações do estabelecimento"),
// mas nunca pode enfraquecer o medicalGuardrail nem os handoffKeywords já
// existentes — só complementa.
function knowledgeGuidanceToText(kb: KnowledgeBase | null): string[] {
  if (!kb) return [];
  const lines: string[] = [];
  if (kb.toneGuidelines) lines.push(`Estilo de conversa definido pelo estabelecimento: ${kb.toneGuidelines}`);
  if (kb.prohibitions) lines.push(`O estabelecimento pediu explicitamente para você NUNCA: ${kb.prohibitions}`);
  if (kb.handoffTriggers) {
    lines.push(
      `O estabelecimento pediu para transferir para um atendente humano (usando ${HANDOFF_TOKEN}) nestas situações: ${kb.handoffTriggers}`,
    );
  }
  return lines;
}

const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

function nowLocal(offsetMin: number): { dateStr: string; human: string } {
  const d = new Date(Date.now() + offsetMin * 60000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const da = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const dateStr = `${y}-${mo}-${da}`;
  // "Amanhã" também vem resolvido: sem isso o modelo precisava calcular a
  // data sozinho e errava (respondeu 04/09 como "amanhã" para uma pergunta
  // sobre um agendamento de 03/09).
  const t = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate()) + 24 * 3600000);
  const tomorrowStr = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
  return {
    dateStr,
    human:
      `Hoje é ${WEEKDAYS[d.getUTCDay()]}, ${da}/${mo}/${y}, ${hh}:${mi} (horário local). ` +
      `Em formato de data: hoje = ${dateStr}, amanhã = ${tomorrowStr}. ` +
      `Nunca calcule "hoje"/"amanhã" de outra forma — use exatamente estas datas.`,
  };
}

// Fatos do cliente que a Livia já sabe, vindos SOMENTE do perfil persistido
// (lib/repo.ts: upsertCustomerProfile, sempre escrito com dado
// determinístico — nunca inferência da IA). Isto é uma fonte de verdade,
// igual à base de conhecimento: a IA deve usar o que está aqui, não
// perguntar de novo nem contradizer sem o cliente dizer o contrário agora.
function customerProfileToText(profile: CustomerProfile | null): string | null {
  if (!profile) return null;
  const parts: string[] = [];
  if (profile.name) parts.push(`Nome: ${profile.name}`);
  if (profile.lastService) parts.push(`Último serviço: ${profile.lastService}`);
  if (profile.preferredProfessional) parts.push(`Profissional preferido: ${profile.preferredProfessional}`);
  if (profile.preferredTime) parts.push(`Horário preferido: ${profile.preferredTime}`);
  if (profile.frequentAddress) parts.push(`Endereço frequente: ${profile.frequentAddress}`);
  if (parts.length === 0) return null;
  return parts.join("\n");
}

const TASK_STATE_LABEL: Record<ConversationTask["state"], string> = {
  collect_service: "ainda precisa descobrir qual serviço o cliente quer",
  collect_date: "ainda precisa descobrir o dia/horário desejado",
  check_availability: "estava consultando horários livres",
  offer_options: "já ofereceu horários e aguarda o cliente escolher",
  confirm: "aguardando confirmação final do cliente antes de criar o agendamento",
  create_appointment: "acabou de tentar criar o agendamento",
};

const TASK_TYPE_LABEL: Record<ConversationTask["type"], string> = {
  schedule_appointment: "agendar um novo horário",
  reschedule_appointment: "remarcar um horário existente",
  cancel_appointment: "cancelar um horário existente",
};

// Continuidade de tarefa (Fase 4): sem isto, cada mensagem reinicia o
// raciocínio do zero e a IA pode voltar a perguntar o que o cliente já
// respondeu antes.
function taskToText(task: ConversationTask | null): string | null {
  if (!task) return null;
  const lines = [
    `Há uma tarefa em andamento: ${TASK_TYPE_LABEL[task.type]}.`,
    `Etapa atual: ${TASK_STATE_LABEL[task.state]}.`,
  ];
  const collected = Object.entries(task.collectedData);
  if (collected.length > 0) {
    lines.push(`Já coletado: ${collected.map(([k, v]) => `${k}=${v}`).join(", ")}.`);
  }
  lines.push("Continue de onde parou — não recomece as perguntas já respondidas.");
  return lines.join("\n");
}

function buildSystemPrompt(
  est: Establishment,
  kb: KnowledgeBase | null,
  nowHuman: string,
  customerProfile: CustomerProfile | null,
  task: ConversationTask | null,
  intent: Intent,
): string {
  const bot = est.bot;
  const persona = bot.personaName || "Livia";
  const rules: string[] = [
    `Você é ${persona}, a atendente virtual de "${est.name}".`,
    `Fale em português do Brasil, de forma ${bot.tone || "acolhedora e objetiva"}.`,
    "Responda SOMENTE com base nas informações do estabelecimento abaixo.",
    "Se a informação não estiver aqui, NÃO invente: ofereça transferir para um atendente.",
    "Seja breve — mensagens curtas, como numa conversa de WhatsApp.",
    "Nunca invente preços, horários, endereços ou disponibilidade.",
    // Regra estrutural: perguntas sobre um agendamento JÁ EXISTENTE só podem
    // ser respondidas com o retorno da ferramenta. A memória da conversa, o
    // resumo e o estado da tarefa NÃO são fonte de verdade sobre a agenda.
    "SEMPRE que a pessoa perguntar sobre um horário que ela já marcou (\"confirma minha consulta\", \"tenho consulta hoje?\", \"qual horário marquei?\", \"você marcou?\", \"quando é meu horário?\"), use a ferramenta get_customer_appointments ANTES de responder. Nunca responda isso pelo histórico da conversa.",
    "Um agendamento com status \"pending\" EXISTE e está reservado — diga o horário e que está aguardando a confirmação da pessoa. Nunca diga que não há agendamento nesse caso.",
    // Antídoto para a promessa vazia: se a resposta depende de checar algo,
    // ou checa agora (ferramenta) ou transfere. Nunca prometer e encerrar.
    "NUNCA diga que vai verificar depois, que já retorna, ou peça para a pessoa aguardar: sua execução termina quando você responde, e ninguém continuaria a verificação. Ou use a ferramenta agora e responda com o resultado, ou transfira para um atendente com request_human_handoff.",
    nowHuman,
  ];
  if (bot.medicalGuardrail) {
    rules.push(
      "NUNCA dê diagnóstico ou orientação médica/clínica/de saúde. Para dúvidas assim, oriente a agendar uma consulta ou falar com um profissional.",
    );
  }
  // Orientação cadastrada pelo comerciante em "Ensine a Livia" — vem DEPOIS
  // do medicalGuardrail de propósito: nada aqui pode enfraquecer essa trava,
  // só complementar tom/proibições/gatilhos de handoff específicos do negócio.
  rules.push(...knowledgeGuidanceToText(kb));
  if (bot.bookingEnabled) {
    rules.push(
      "Você PODE agendar, remarcar e cancelar. Regras:",
      "- Descubra o serviço desejado e o dia de preferência.",
      "- SEMPRE use a ferramenta find_available_appointments para ver horários livres reais antes de oferecer horários. Nunca chute horários.",
      "- Ofereça algumas opções de horário ao cliente.",
      "- Só depois que o cliente escolher e confirmar, use create_appointment com o startAt exato do horário escolhido (o valor vem de find_available_appointments).",
      "- Antes de remarcar, cancelar ou confirmar qualquer coisa, use get_customer_appointments para ver o que a pessoa REALMENTE tem marcado.",
      "- Para remarcar um horário já existente, use reschedule_appointment (também com um startAt vindo de find_available_appointments).",
      "- Para cancelar, use cancel_appointment.",
      "- Se a pessoa confirmar que vai comparecer (\"confirmo\", \"sim, vou\"), use confirm_appointment. O horário só passa a contar como confirmado se essa ferramenta devolver sucesso.",
      "- Após criar/remarcar/cancelar, confirme os detalhes (serviço, dia e hora) em uma frase curta.",
    );
  } else {
    rules.push("Você ainda não fecha agendamentos; para marcar, oriente a pessoa a falar com a equipe.");
  }
  rules.push(
    `Se a pessoa pedir um humano/atendente, demonstrar irritação, ou pedir algo fora do seu escopo, responda com acolhimento e chame a ferramenta request_human_handoff com um motivo curto. Se por algum motivo não conseguir chamar a ferramenta, inclua o marcador ${HANDOFF_TOKEN} ao final da resposta em texto (ele não aparece para o cliente).`,
  );
  const sections = [rules.join("\n"), "", "=== INFORMAÇÕES DO ESTABELECIMENTO ===", knowledgeToText(kb)];

  const profileText = customerProfileToText(customerProfile);
  if (profileText) {
    sections.push("", "=== O QUE VOCÊ JÁ SABE SOBRE ESTE CLIENTE ===", profileText);
  }

  const taskText = taskToText(task);
  if (taskText) {
    sections.push("", "=== TAREFA EM ANDAMENTO ===", taskText);
  }

  // Passo 7 — checagem de confiança: quando a intenção detectada pede um
  // dado factual (preço/horário/endereço) e a base não tem esse dado, a
  // regra geral já no topo ("nunca invente") fica reforçada com a lacuna
  // ESPECÍFICA desta mensagem — mais eficaz do que confiar só na instrução
  // genérica. Determinístico (lib/ai/trustPolicy.ts): zero chamadas de IA
  // extras.
  const trust = evaluateTrust(intent, kb);
  if (!trust.hasSource && trust.directive) {
    sections.push("", "=== ATENÇÃO PARA ESTA RESPOSTA ===", trust.directive);
  }

  return sections.join("\n");
}

export interface BrainInput {
  est: Establishment;
  kb: KnowledgeBase | null;
  history: Message[]; // ordem cronológica, já com a mensagem atual do cliente
  contactPhone: string;
  contactName: string | null;
  // Fase 1 e 4: memória do cliente e tarefa em andamento, já carregadas pelo
  // chamador (webhook) — brain.ts só consome, nunca lê/grava Firestore
  // diretamente, mantendo esta função sem I/O de persistência.
  customerProfile: CustomerProfile | null;
  task: ConversationTask | null;
  // Passo 3, já calculado pelo webhook (determinístico) — reaproveitado aqui
  // pro Passo 7 (checagem de confiança), sem recalcular nem gastar IA.
  intent: Intent;
}

export interface BrainResult {
  reply: string;
  // true quando o texto tinha o marcador legado [[HANDOFF]] OU a ferramenta
  // request_human_handoff foi chamada — nunca inferido de outra forma. Quem
  // decide gravar a mudança de status é app/api/webhooks/whatsapp/route.ts.
  handoff: boolean;
  // Cada um só fica true quando a FERRAMENTA correspondente devolveu
  // sucesso — nunca por o texto da IA "parecer" ter concluído algo (Passo 6:
  // "nunca permita que texto produzido pelo modelo seja considerado prova de
  // que uma operação aconteceu").
  booked: boolean;
  rescheduled: boolean;
  cancelled: boolean;
  // Ferramentas efetivamente chamadas nesta rodada, em ordem — usado por
  // lib/ai/taskState.ts para derivar o próximo estado da tarefa (Fase 4) sem
  // duplicar a lógica de quando cada ferramenta roda.
  toolCalls: ToolCallRecord[];
}

export async function think(input: BrainInput): Promise<BrainResult> {
  const { est, kb, history, contactPhone, contactName, customerProfile, task, intent } = input;
  const booking = est.bot.bookingEnabled;

  // Offset (para contexto de data e para as ferramentas). Sem booking, evita
  // o custo de ler a config — as ferramentas que precisam dela e não a
  // recebem carregam sob demanda (ver lib/ai/tools.ts: get_business_hours).
  const config = booking ? await getScheduleConfig(est.id) : null;
  const offset = config?.utcOffsetMinutes ?? -180;
  const now = nowLocal(offset);

  const toolCtx: ToolContext = { est, kb, config, contactPhone, contactName, offset, customerProfile };
  const tools = toolsFor(toolCtx);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: buildSystemPrompt(est, kb, now.human, customerProfile, task, intent) },
    ...history.map((m) => ({
      role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    })),
  ];

  let booked = false;
  let rescheduled = false;
  let cancelled = false;
  let handoffRequested = false;
  const toolCalls: ToolCallRecord[] = [];

  // Loop de ferramentas (máx. algumas iterações pra não travar).
  for (let i = 0; i < 4; i++) {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 500,
      ...(tools.length > 0 ? { tools } : {}),
    });
    const msg = completion.choices[0]?.message;
    if (!msg) break;

    if (msg.tool_calls?.length) {
      messages.push(msg as OpenAI.Chat.ChatCompletionMessageParam);
      for (const tc of msg.tool_calls) {
        const name = tc.function.name as ToolName;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          // args malformado — segue com {} e deixa a ferramenta validar.
        }
        toolCalls.push({ name, args });

        const result = await runTool(name, args, toolCtx);
        if (result.ok) {
          if (name === "create_appointment") booked = true;
          if (name === "reschedule_appointment") rescheduled = true;
          if (name === "cancel_appointment") cancelled = true;
          if (name === "request_human_handoff") handoffRequested = true;
        }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue; // volta ao modelo com os resultados
    }

    let reply = msg.content?.trim() ?? "";
    const handoff = handoffRequested || reply.includes(HANDOFF_TOKEN);
    if (reply.includes(HANDOFF_TOKEN)) reply = reply.replaceAll(HANDOFF_TOKEN, "").trim();
    if (!reply) reply = "Desculpa, não consegui entender agora. Quer que eu chame um atendente pra te ajudar?";
    return { reply, handoff, booked, rescheduled, cancelled, toolCalls };
  }

  // Estouro do loop de ferramentas sem resposta final. A mensagem anterior
  // aqui ("já te retorno") era uma promessa VAZIA: nada continuava depois do
  // return, e o cliente ficava esperando para sempre. Agora transfere de
  // verdade — handoff: true faz o webhook mudar a conversa para "handoff" e
  // avisa que alguém vai assumir.
  return {
    reply: "Vou chamar uma pessoa da equipe para te ajudar com isso, tudo bem? Já já alguém te responde por aqui.",
    handoff: true,
    booked,
    rescheduled,
    cancelled,
    toolCalls,
  };
}
