// Fila de pendências — Passo 9 do README.md/Plano Mestre.
//
// Função pura (sem I/O): decide se a conversa, DEPOIS desta rodada, tem algo
// pendente de ação — e de que tipo. Integrada de propósito ao Intent (Passo
// 3) e ao ConversationTask (Passo 4/Pacote 1) já calculados, em vez de
// reimplementar detecção própria. Quem persiste (upsert/resolve) é
// lib/repo.ts, chamado pelo webhook — aqui não há Firestore.
import type { ConversationTask, Intent, PendingTaskType } from "@/types";

export interface PendingTaskDraft {
  type: PendingTaskType;
  waitingFor: string;
}

export interface DerivePendingTaskInput {
  intent: Intent;
  // true se a Livia pediu handoff NESTA rodada, ou a conversa já estava em
  // handoff antes dela.
  handoffActive: boolean;
  // Estado da tarefa já derivado por lib/ai/taskState.ts para esta rodada
  // (null = nenhuma tarefa ativa).
  task: ConversationTask | null;
  // Alguma operação (agendar/remarcar/cancelar) concluiu com sucesso agora —
  // sempre resolve qualquer pendência, independente do que ela era.
  operationCompleted: boolean;
}

// null = sem pendência (resolve qualquer uma que já existisse pra esta
// conversa).
export function derivePendingTask(input: DerivePendingTaskInput): PendingTaskDraft | null {
  const { intent, handoffActive, task, operationCompleted } = input;

  if (operationCompleted) return null;

  if (handoffActive) {
    return { type: "awaiting_human", waitingFor: "atendimento humano" };
  }

  if (task) {
    if (task.state === "confirm") {
      return { type: "awaiting_customer_confirmation", waitingFor: "cliente confirmar o horário" };
    }
    return { type: "appointment_started_incomplete", waitingFor: "concluir o agendamento em andamento" };
  }

  // Reclamação sem handoff explícito nesta rodada — a IA pode ter respondido
  // sem transferir; ainda assim é algo que o estabelecimento pode querer
  // revisar (exemplo do próprio plano: "exceção que precisa do
  // estabelecimento").
  if (intent.type === "complaint") {
    return { type: "exception_needs_establishment", waitingFor: "reclamação do cliente" };
  }

  return null;
}
