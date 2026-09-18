// Rótulos de exibição — só para o frontend. O valor real (EstablishmentType)
// continua definido em types/index.ts; este mapa nunca deve virar fonte de
// verdade de dado, só de texto.
import type { EstablishmentType, IntentType, CampaignStatus, CampaignRecipientStatus } from "@/types";
import type { StatusTone } from "@/components/ui/StatusBadge";

export const ESTABLISHMENT_TYPE_LABELS: Record<EstablishmentType, string> = {
  clinica: "Clínica",
  pet: "Pet",
  salao: "Salão",
  estetica: "Estética",
  odonto: "Odonto",
  oficina: "Oficina mecânica",
  academia: "Academia",
  imobiliaria: "Imobiliária",
  outro: "Outro",
};

// Rótulos de exibição pra IntentType (lib/ai/intent.ts) — usado no CRM, na
// caixa de entrada e no painel diário. Mesmo cuidado: só texto, o valor real
// continua vindo de types/index.ts.
export const INTENT_LABEL: Record<IntentType, string> = {
  schedule_appointment: "Quer agendar",
  reschedule_appointment: "Quer remarcar",
  cancel_appointment: "Quer cancelar",
  check_appointment: "Consultou agendamento",
  ask_price: "Perguntou preço",
  ask_hours: "Perguntou horário",
  ask_address: "Perguntou endereço",
  human_handoff: "Pediu atendente",
  complaint: "Reclamação",
  general_question: "Pergunta geral",
};

// Campanhas — CampaignStatus/CampaignRecipientStatus vêm do domínio real
// (types/index.ts, fundação de CAMPANHAS-02). Sem "failed" em
// CampaignStatus de propósito: falha é sempre por destinatário
// (CampaignRecipientStatus.failed), nunca da campanha inteira.
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, { label: string; tone: StatusTone }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  scheduled: { label: "Agendada", tone: "info" },
  running: { label: "Em andamento", tone: "warning" },
  completed: { label: "Concluída", tone: "success" },
  canceled: { label: "Cancelada", tone: "danger" },
};

export const CAMPAIGN_RECIPIENT_STATUS_LABEL: Record<CampaignRecipientStatus, { label: string; tone: StatusTone }> = {
  queued: { label: "Na fila", tone: "neutral" },
  leased: { label: "Enviando", tone: "info" },
  sent: { label: "Enviado", tone: "info" },
  delivered: { label: "Entregue", tone: "info" },
  read: { label: "Lido", tone: "success" },
  replied: { label: "Respondeu", tone: "success" },
  failed: { label: "Falhou", tone: "danger" },
  skipped: { label: "Ignorado", tone: "neutral" },
};

export const WEEKDAY_LABELS: { key: string; label: string; short: string }[] = [
  { key: "1", label: "Segunda", short: "Seg" },
  { key: "2", label: "Terça", short: "Ter" },
  { key: "3", label: "Quarta", short: "Qua" },
  { key: "4", label: "Quinta", short: "Qui" },
  { key: "5", label: "Sexta", short: "Sex" },
  { key: "6", label: "Sábado", short: "Sáb" },
  { key: "0", label: "Domingo", short: "Dom" },
];
