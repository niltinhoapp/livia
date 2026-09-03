// O "cérebro" da Livia: transforma a base de conhecimento + o histórico numa
// resposta. Com booking habilitado, a IA ganha "ferramentas" (function calling)
// para consultar horários livres e criar agendamentos sozinha, durante a
// conversa — sempre com o horário vindo da disponibilidade real (sem inventar).
import OpenAI from "openai";
import type { Establishment, KnowledgeBase, Message, CustomerProfile, ConversationTask, Intent } from "@/types";
import { getScheduleConfig, localToEpoch, assertBookable } from "@/lib/scheduling";
import { parseTimeSelection } from "@/lib/ai/timeSelection";
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
  appointmentLookup: { ok: boolean; data?: unknown } | null,
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

  // Resultado da consulta OBRIGATÓRIA à agenda (intenção check_appointment).
  // Os dados já estão aqui: não há nada a "verificar depois".
  if (appointmentLookup) {
    sections.push(
      "",
      "=== AGENDA REAL DESTE CLIENTE (consultada agora) ===",
      appointmentLookup.ok
        ? JSON.stringify(appointmentLookup.data)
        : "A consulta à agenda FALHOU. Não invente nenhum horário: diga que não conseguiu checar agora e transfira para um atendente.",
      appointmentLookup.ok
        ? "Estes são os dados reais da agenda, já consultados. Responda AGORA com base neles, citando serviço e horário. É PROIBIDO dizer que vai verificar, pedir um momento ou mandar aguardar — a consulta já foi feita e o resultado está acima."
        : "",
    );
  }

  return sections.filter((s) => s !== "").join("\n");
}

// Frases que prometem uma verificação futura que NUNCA vai acontecer (a
// execução termina quando a resposta é enviada). Usadas para barrar essa
// resposta quando os dados já estavam disponíveis.
// "aguardando" NÃO entra: é legítimo descrevendo o status do agendamento
// ("aguardando sua confirmação"). Só a forma imperativa ("aguarde") é
// enrolação. Regex frouxa demais aqui descartaria respostas corretas.
const STALLING_PATTERNS =
  /\b(vou verificar|vou checar|vou consultar|vou dar uma olhada|deixa eu (ver|verificar|conferir|checar)|um momento|um instante|aguarde|já (te )?retorno|já volto|volto já|verifico e (te )?aviso|te retorno|te aviso em seguida)\b/i;

export function looksLikeStalling(reply: string): boolean {
  return STALLING_PATTERNS.test(reply);
}

// Afirmações de DESFECHO operacional que só o backend pode fazer. Se o texto
// contém uma destas e nenhuma ferramenta de agenda rodou no turno, o modelo
// está inventando — foi assim que "13:00 já foi ocupado" chegou ao cliente
// com a agenda vazia naquele horário.
const UNAVAILABLE_CLAIM =
  /\b(ocupad[oa]|indispon[íi]vel|n[ãa]o (est[áa]|esta) dispon[íi]vel|j[áa] foi (pego|reservad[oa]|preenchid[oa])|n[ãa]o (h[áa]|tem) (mais )?(vaga|hor[áa]rio))\b/i;

export function claimsUnavailability(reply: string): boolean {
  return UNAVAILABLE_CLAIM.test(reply);
}

// O desfecho REAL da tentativa de reserva entra no prompt como fato
// consumado. O modelo redige a mensagem; não decide o resultado.
function bookingOutcomeSection(outcome: BookingOutcome | null): string {
  if (!outcome) return "";
  const cabecalho = "\n\n=== RESULTADO REAL DA RESERVA (executado agora pelo sistema) ===\n";

  if (outcome.kind === "created") {
    return (
      cabecalho +
      `AGENDAMENTO CRIADO com sucesso: ${outcome.serviceName} em ${outcome.when}. ` +
      "Confirme isso ao cliente de forma curta e simpática. NUNCA diga que o horário estava ocupado ou que não foi possível."
    );
  }

  if (outcome.kind === "free_needs_service") {
    return (
      cabecalho +
      `O horário ${outcome.time} ESTÁ DISPONÍVEL, mas ainda falta saber o serviço. ` +
      "Pergunte qual serviço a pessoa quer. NUNCA diga que o horário está ocupado."
    );
  }

  const alternativas = outcome.alternatives.map((a) => a.time).join(", ");
  return (
    cabecalho +
    `O horário escolhido NÃO pôde ser reservado (motivo: ${outcome.reason}). ` +
    (alternativas
      ? `Horários realmente livres nesse dia: ${alternativas}. Ofereça SOMENTE estes.`
      : "Não há horários livres nesse dia; ofereça outro dia.") +
    " Nunca invente outros horários."
  );
}

// Estados de tarefa em que o cliente pode estar escolhendo um horário.
const AWAITING_TIME_CHOICE = new Set<ConversationTask["state"]>(["offer_options", "confirm", "check_availability"]);

export type BookingOutcome =
  | { kind: "created"; when: string; serviceName: string }
  | { kind: "conflict"; reason: string; alternatives: { time: string }[] }
  | { kind: "free_needs_service"; time: string };

// Resolve deterministicamente uma escolha de horário do cliente: converte o
// horário para instante concreto usando a data JÁ coletada na tarefa e o fuso
// do estabelecimento, e executa a reserva pelo backend. Devolve `null` quando
// não é o caso (sem tarefa, sem data coletada, ou a mensagem não é escolha de
// horário) — aí o fluxo segue normal.
async function resolveTimeSelection(
  input: BrainInput,
  toolCtx: ToolContext,
  config: Awaited<ReturnType<typeof getScheduleConfig>> | null,
  toolCalls: ToolCallRecord[],
): Promise<BookingOutcome | null> {
  const { task, history } = input;
  if (!task || !config) return null;
  if (task.type !== "schedule_appointment" && task.type !== "reschedule_appointment") return null;
  if (!AWAITING_TIME_CHOICE.has(task.state)) return null;

  const ultima = [...history].reverse().find((m) => m.role === "customer");
  if (!ultima) return null;

  const escolhido = parseTimeSelection(ultima.text);
  const date = typeof task.collectedData.date === "string" ? task.collectedData.date : undefined;
  if (!escolhido || !date) return null;

  const startAt = localToEpoch(date, escolhido.hour * 60 + escolhido.minute, config.utcOffsetMinutes);
  const serviceName =
    typeof task.collectedData.serviceName === "string" ? task.collectedData.serviceName : undefined;

  // Sem serviço definido não dá para criar — mas a disponibilidade ainda é
  // decidida pelo backend, nunca pelo modelo.
  if (!serviceName) {
    const motivo = await assertBookable(toolCtx.est.id, config, startAt, config.defaultDurationMin);
    if (motivo) {
      return { kind: "conflict", reason: motivo, alternatives: await realAlternatives(toolCtx, date, toolCalls) };
    }
    return { kind: "free_needs_service", time: `${String(escolhido.hour).padStart(2, "0")}:${String(escolhido.minute).padStart(2, "0")}` };
  }

  const result = await runTool("create_appointment", { serviceName, startAt }, toolCtx);
  toolCalls.push({ name: "create_appointment", args: { serviceName, startAt } });

  if (result.ok) {
    const data = result.data as { when?: string } | undefined;
    return { kind: "created", when: data?.when ?? "", serviceName };
  }
  return {
    kind: "conflict",
    reason: result.reasonCode ?? result.error ?? "indisponível",
    alternatives: await realAlternatives(toolCtx, date, toolCalls),
  };
}

// Alternativas REAIS para o mesmo dia — nunca inventadas pelo modelo.
async function realAlternatives(
  toolCtx: ToolContext,
  date: string,
  toolCalls: ToolCallRecord[],
): Promise<{ time: string }[]> {
  const result = await runTool("find_available_appointments", { date }, toolCtx);
  toolCalls.push({ name: "find_available_appointments", args: { date } });
  const data = result.data as { slots?: { time: string }[] } | undefined;
  return (data?.slots ?? []).slice(0, 5).map((s) => ({ time: s.time }));
}

// Resposta determinística montada a partir dos dados REAIS da agenda. Usada
// quando o modelo enrola mesmo tendo os dados no prompt — assim "aguarde" é
// estruturalmente impossível neste fluxo, e não uma regra que o modelo pode
// ignorar.
export function composeAppointmentReply(data: unknown): string | null {
  const parsed = data as
    | { appointments?: { serviceName?: string; day?: string; time?: string; date?: string; status?: string }[] }
    | undefined;
  const appointments = parsed?.appointments;
  if (!Array.isArray(appointments)) return null;

  if (appointments.length === 0) {
    return "Procurei aqui e não encontrei nenhum horário marcado no seu nome. Quer que eu veja os horários disponíveis pra você?";
  }

  const partes = appointments.map((a) => {
    const quando = a.day === "hoje" || a.day === "amanhã" ? a.day : a.date;
    const servico = a.serviceName ? `${a.serviceName} ` : "";
    const pendente = a.status === "pending" ? " (aguardando sua confirmação)" : "";
    return `${servico}${quando} às ${a.time}${pendente}`;
  });

  const lista = partes.length === 1 ? partes[0] : partes.map((p) => `• ${p}`).join("\n");
  const temPendente = appointments.some((a) => a.status === "pending");
  const fecho = temPendente ? " Posso confirmar sua presença?" : "";

  return appointments.length === 1
    ? `Sim! Seu horário está marcado: ${lista}.${fecho}`
    : `Você tem estes horários marcados:\n${lista}${fecho}`;
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

  let booked = false;
  let rescheduled = false;
  let cancelled = false;
  let handoffRequested = false;
  // Só uma correção de enrolação por turno — evita laço com um modelo teimoso.
  let stallCorrected = false;
  const toolCalls: ToolCallRecord[] = [];

  // ---- Consulta OBRIGATÓRIA à fonte de verdade ----
  // Quando a mensagem é deterministicamente uma pergunta sobre um
  // agendamento existente, o backend consulta a agenda ANTES de gerar a
  // resposta e injeta o resultado no prompt. Não é uma instrução ao modelo:
  // com tool_choice em "auto" ele podia (e em Production, fez) responder em
  // texto sem chamar ferramenta nenhuma — respondeu "vou verificar, um
  // momento" com um Appointment real existindo na agenda.
  let appointmentLookup: Awaited<ReturnType<typeof runTool>> | null = null;
  if (intent.type === "check_appointment") {
    appointmentLookup = await runTool("get_customer_appointments", {}, toolCtx);
    toolCalls.push({ name: "get_customer_appointments", args: {} });
  }

  // ---- Escolha de horário: o BACKEND decide, o modelo só comunica ----
  //
  // Quando existe uma tarefa de agendamento aguardando escolha e o cliente
  // responde só um horário ("13", "14;30"), essa mensagem não casa com
  // nenhuma regra de intenção — e antes disto o modelo ficava livre para
  // declarar sozinho "13:00 já foi ocupado", sem nunca consultar a agenda.
  // Foi exatamente o que aconteceu em Production: os conflitos anunciados não
  // existiam.
  //
  // Agora o backend resolve o horário, valida e TENTA RESERVAR antes de
  // gerar qualquer texto. "Confirmado", "ocupado" e "indisponível" passam a
  // ser sempre resultado real de execução.
  const bookingOutcome = booking ? await resolveTimeSelection(input, toolCtx, config, toolCalls) : null;
  if (bookingOutcome?.kind === "created") booked = true;

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        buildSystemPrompt(est, kb, now.human, customerProfile, task, intent, appointmentLookup) +
        bookingOutcomeSection(bookingOutcome),
    },
    ...history.map((m) => ({
      role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
      content: m.text,
    })),
  ];

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
    let handoff = handoffRequested || reply.includes(HANDOFF_TOKEN);
    if (reply.includes(HANDOFF_TOKEN)) reply = reply.replaceAll(HANDOFF_TOKEN, "").trim();

    // Trava determinística do fluxo de consulta de agenda: se a consulta deu
    // certo, os dados JÁ estão disponíveis — enrolar ("vou verificar", "um
    // momento") ou transferir é sempre errado aqui. Substitui por uma
    // resposta montada a partir do Appointment real, em vez de confiar que o
    // modelo obedeceu ao prompt (em Production ele não obedeceu).
    if (appointmentLookup?.ok) {
      if (!reply || looksLikeStalling(reply)) {
        const composed = composeAppointmentReply(appointmentLookup.data);
        if (composed) {
          reply = composed;
          handoff = false; // a consulta funcionou: não há motivo para transferir
        }
      }
    } else if (appointmentLookup && !appointmentLookup.ok) {
      // A consulta à agenda falhou de verdade — aí sim é caso de humano,
      // dito claramente, sem prometer voltar depois.
      reply = "Não consegui checar a agenda agora. Vou chamar uma pessoa da equipe pra te confirmar isso, tudo bem?";
      handoff = true;
    }

    // ---- Trava de desfecho inventado ----
    //
    // "Ocupado"/"indisponível" só pode existir se alguma ferramenta de agenda
    // tiver rodado neste turno. Sem isso, o modelo está afirmando um estado
    // operacional que ninguém verificou — o bug original. Substituímos pela
    // verdade quando temos, ou forçamos a consulta quando não temos.
    if (claimsUnavailability(reply)) {
      const consultouAgenda = toolCalls.some(
        (t) => t.name === "create_appointment" || t.name === "find_available_appointments",
      );
      if (bookingOutcome?.kind === "created") {
        // Contradiz o backend: a reserva FOI criada.
        reply = `Prontinho! Seu horário de ${bookingOutcome.serviceName} está reservado para ${bookingOutcome.when}.`;
        handoff = false;
      } else if (!consultouAgenda) {
        if (!stallCorrected) {
          stallCorrected = true;
          messages.push({ role: "assistant", content: reply });
          messages.push({
            role: "system",
            content:
              "A resposta acima afirmou que um horário está ocupado/indisponível, mas NENHUMA consulta à agenda foi feita. Você não pode declarar isso por conta própria. Use find_available_appointments (ou create_appointment, se a pessoa já escolheu) e responda com o resultado real.",
          });
          continue;
        }
        reply = "Vou chamar uma pessoa da equipe pra confirmar esse horário com você.";
        handoff = true;
      }
    }

    // ---- Regra geral: promessa de continuação inexistente ----
    //
    // Vale para QUALQUER turno, não só consulta de agenda. A execução termina
    // aqui: nada roda depois para mandar uma segunda mensagem sozinha. Se o
    // modelo enrolou ("vou verificar", "um momento"), damos UMA segunda
    // passada com a correção explícita — ou ele responde com o que já tem, ou
    // pede o dado que falta. Persistindo, transferimos de verdade em vez de
    // deixar o cliente esperando por algo que nunca vem.
    //
    // Foi o caso real: o cliente disse "Nilton", ainda faltava o DIA, e a
    // Livia respondeu "vou verificar a disponibilidade, um momento" — quando
    // o certo era continuar pedindo o dia.
    if (looksLikeStalling(reply) && !handoff) {
      if (!stallCorrected) {
        stallCorrected = true;
        messages.push({ role: "assistant", content: reply });
        messages.push({
          role: "system",
          content:
            "A resposta acima prometeu verificar algo depois. Isso é impossível: sua execução termina agora e NENHUMA outra mensagem será enviada automaticamente. Reescreva a resposta seguindo exatamente uma destas opções: (a) se você já tem os dados ou pode obtê-los com uma ferramenta, use a ferramenta agora e responda com o resultado; (b) se falta alguma informação do cliente (dia, horário, serviço), PEÇA essa informação de forma direta; (c) se não há como resolver, chame request_human_handoff. Nunca diga 'vou verificar', 'um momento' ou 'aguarde'.",
        });
        continue;
      }
      // Segunda tentativa também enrolou: transfere de verdade.
      reply = "Vou chamar uma pessoa da equipe pra te ajudar com isso — já já alguém te responde por aqui.";
      handoff = true;
    }

    if (!reply) reply = "Desculpa, não consegui entender agora. Quer que eu chame um atendente pra te ajudar?";
    return { reply, handoff, booked, rescheduled, cancelled, toolCalls };
  }

  // Estouro do loop de ferramentas sem resposta final. Se a consulta de
  // agenda tinha dado certo, responde com o dado real em vez de transferir —
  // a informação estava disponível o tempo todo.
  if (appointmentLookup?.ok) {
    const composed = composeAppointmentReply(appointmentLookup.data);
    if (composed) {
      return { reply: composed, handoff: false, booked, rescheduled, cancelled, toolCalls };
    }
  }

  // A mensagem anterior aqui ("já te retorno") era uma promessa VAZIA: nada
  // continuava depois do return, e o cliente ficava esperando para sempre.
  // Agora transfere de verdade — handoff: true faz o webhook mudar a conversa
  // para "handoff" e avisa que alguém vai assumir.
  return {
    reply: "Vou chamar uma pessoa da equipe para te ajudar com isso, tudo bem? Já já alguém te responde por aqui.",
    handoff: true,
    booked,
    rescheduled,
    cancelled,
    toolCalls,
  };
}
