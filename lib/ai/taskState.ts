// Estado e próximo passo — Fase 4 de docs/ORDEM-IMPLEMENTACAO-INTELIGENCIA.md.
//
// Função pura (sem I/O): recebe a tarefa atual, a intenção detectada nesta
// mensagem e o que a IA efetivamente fez (ferramentas chamadas + se um
// agendamento foi criado) e devolve a próxima tarefa. Só o webhook decide
// persistir o resultado — mantém isto testável sem Firestore/rede.
import type { ConversationTask, Intent, TaskState } from "@/types";

const TASK_INTENTS = new Set(["schedule_appointment", "reschedule_appointment", "cancel_appointment"]);

// Nomes de todas as ferramentas da camada padronizada (lib/ai/tools.ts) —
// esta função só reage às relacionadas a agendamento; as demais passam por
// aqui sem efeito no estado da tarefa.
export type ToolName =
  | "get_business_hours"
  | "search_knowledge_base"
  | "get_customer_profile"
  | "update_customer_profile"
  | "find_available_appointments"
  | "create_appointment"
  | "reschedule_appointment"
  | "cancel_appointment"
  | "request_human_handoff";

export interface ToolCallRecord {
  name: ToolName;
  args: Record<string, unknown>;
}

export interface DeriveTaskStateInput {
  existingTask: ConversationTask | null | undefined;
  intent: Intent;
  toolCalls: ToolCallRecord[];
  booked: boolean;
}

// null = nenhuma tarefa ativa (limpa o campo no Firestore).
export function deriveTaskState(input: DeriveTaskStateInput): ConversationTask | null {
  const { existingTask, intent, toolCalls, booked } = input;
  const now = Date.now();

  // Agendamento concluído agora: a tarefa terminou, independente de qual era
  // o estado anterior.
  if (booked) return null;

  const startsNewTask = TASK_INTENTS.has(intent.type);
  const sameTaskContinuing = existingTask && existingTask.type === intent.type;

  // Uma intenção de tarefa NOVA e DIFERENTE da que estava em andamento
  // substitui a tarefa anterior (ex.: cliente pede para cancelar no meio de
  // um agendamento em curso) — nunca mistura os dois estados.
  if (startsNewTask && !sameTaskContinuing) {
    return {
      type: intent.type as ConversationTask["type"],
      state: nextStateFromTools(toolCalls, "collect_service"),
      collectedData: collectFromTools(toolCalls, {}),
      missingData: [],
      updatedAt: now,
    };
  }

  // Mesma tarefa continuando (a intenção desta mensagem bate com a tarefa
  // ativa, ou não há intenção de tarefa nova mas já havia uma em andamento —
  // ex. "sexta de manhã" não dispara nenhuma keyword de agendamento, mas a
  // conversa está no meio de um).
  if (existingTask) {
    return {
      ...existingTask,
      state: nextStateFromTools(toolCalls, existingTask.state),
      collectedData: collectFromTools(toolCalls, existingTask.collectedData),
      updatedAt: now,
    };
  }

  // Sem tarefa ativa e sem intenção que inicie uma — nada a rastrear
  // (perguntas factuais, conversa geral).
  return null;
}

// Avança o estado com base no que a IA realmente chamou nesta rodada. Nunca
// retrocede: se a tarefa já estava em "offer_options" e esta rodada não
// chamou nenhuma ferramenta (cliente só respondeu algo que a IA processou em
// texto), o estado permanece — é exatamente o que evita a IA "esquecer" e
// recomeçar.
function nextStateFromTools(toolCalls: ToolCallRecord[], current: TaskState): TaskState {
  const calledCreate = toolCalls.some((t) => t.name === "create_appointment" || t.name === "reschedule_appointment");
  const calledCheck = toolCalls.some((t) => t.name === "find_available_appointments");
  if (calledCreate) return "confirm"; // tentou criar/remarcar; só chega a null (concluído) via `booked`
  if (calledCheck) return "offer_options";
  return current;
}

// Só extrai campos que vieram de uma chamada de ferramenta real — nunca um
// palpite da IA. `date`/`serviceName` são os únicos que o restante do
// sistema usa hoje (ver runCheckAvailability/runCreateAppointment em
// lib/ai/brain.ts); os demais argumentos não são estruturais o suficiente
// para valer a pena guardar aqui.
function collectFromTools(
  toolCalls: ToolCallRecord[],
  base: Record<string, string | number>,
): Record<string, string | number> {
  const data = { ...base };
  for (const call of toolCalls) {
    if (typeof call.args.date === "string") data.date = call.args.date;
    if (typeof call.args.serviceName === "string") data.serviceName = call.args.serviceName;
  }
  return data;
}
