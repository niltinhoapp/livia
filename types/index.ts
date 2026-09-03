// Tipos centrais da Livia. Espelham as coleções do Firestore.
// Multi-tenant: tudo vive sob establishments/{establishmentId}/...

export type EstablishmentType =
  | "clinica"
  | "pet"
  | "salao"
  | "estetica"
  | "odonto"
  | "oficina"
  | "academia"
  | "imobiliaria"
  | "outro";

export interface Establishment {
  id: string;
  name: string;
  type: EstablishmentType;
  ownerUid: string;
  status: "active" | "suspended";
  createdAt: number;
  // Conta de WhatsApp própria (conectada via Embedded Signup — mesmo fluxo
  // do Nuvem Rush). A Meta cobra as conversas direto do estabelecimento.
  whatsapp?: EstablishmentWhatsapp;
  // Configuração do bot (persona + regras).
  bot: BotConfig;
}

// "connecting" existe para uma garantia específica: o PIN de registro é
// aceito e APLICADO pela Meta no momento do POST /register — se a Livia só
// persistisse o PIN depois disso, uma falha entre o /register bem-sucedido e
// a escrita no Firestore perderia a credencial permanentemente (mensagens
// continuariam funcionando, mas um re-registro futuro do número ficaria
// impossível). Por isso o PIN é gerado e gravado cifrado como "connecting"
// ANTES de qualquer chamada a /register — nunca depois.
//   "connecting"    -> claim em andamento; SÓ tem pin cifrado + IDs. NUNCA
//                      tratado como conexão válida por nenhum consumidor
//                      (webhook, painel) — só "connected" habilita o canal.
//   "connected"     -> sequência completa; accessToken cifrado presente.
//   "disconnected"  -> o estabelecimento desconectou pelo painel. Mantém
//                      wabaId/phoneNumberId e os PINs já cifrados para
//                      permitir reconectar o MESMO número depois sem gerar
//                      um PIN novo (que a Meta recusaria com 133005). NÃO
//                      tem accessToken: nada é enviado nem recebido.
export interface EstablishmentWhatsapp {
  wabaId: string;
  phoneNumberId: string;
  status: "connecting" | "connected" | "disconnected";
  // PIN de registro (2 etapas do número na Cloud API) — gerado pela Livia,
  // nunca escolhido pelo estabelecimento, sempre cifrado (encryptPin/
  // decryptPin em lib/whatsapp/tokenCrypto.ts). Campo separado do
  // accessToken mesmo cifrado — usos e ciclos de vida diferentes. Presente
  // já no estado "connecting" (é o primeiro dado persistido do fluxo).
  //
  // LEGADO: era o único PIN guardado, sempre o do `phoneNumberId` corrente.
  // Continua sendo lido (e migrado para `pinsByPhoneNumberId`) em documentos
  // criados antes do mapa existir, mas escritas novas alimentam o mapa.
  pin?: EncryptedToken;
  // PIN por número, cifrado, indexado pelo phone_number_id.
  //
  // O PIN de 2 etapas pertence ao NÚMERO na Meta, não à conexão: uma vez
  // registrado, aquele número só aceita re-registro com o MESMO PIN (erro
  // 133005 caso contrário). Guardar um PIN único quebrava o caso real de um
  // cliente trocar de número e depois voltar para o anterior — o PIN do
  // antigo teria sido sobrescrito e o retorno seria impossível. O mapa
  // preserva o PIN de cada número já registrado por este estabelecimento.
  //
  // A chave é o phone_number_id (só dígitos), seguro como nome de campo do
  // Firestore.
  pinsByPhoneNumberId?: Record<string, EncryptedToken>;
  // Presente somente quando status === "connected". Nunca em texto puro —
  // sempre o resultado de encryptToken() (lib/whatsapp/tokenCrypto.ts).
  accessToken?: EncryptedToken;
  connectedAt?: number;
  tokenRefreshedAt?: number;
  // Quando o estabelecimento desconectou pelo painel (POST
  // /api/whatsapp/disconnect). Só presente no estado "disconnected".
  disconnectedAt?: number;
  // Quando a claim ("connecting") foi criada/retomada.
  claimedAt?: number;
  // Lease exclusiva da tentativa em andamento (só relevante enquanto
  // status === "connecting"). attemptId identifica QUAL requisição tem
  // permissão de finalizar; leaseExpiresAt limita por quanto tempo, sem
  // exigir que uma tentativa travada bloqueie novas tentativas para sempre.
  // Ambos somem (deletados) quando a conexão finaliza ou a lease é liberada
  // manualmente após uma falha — ver lib/repo.ts.
  attemptId?: string;
  leaseExpiresAt?: number;
  // Só presente quando a Livia efetivamente registrou o número agora
  // (POST /register retornou sucesso). Se a Meta já considerava o número
  // registrado (alreadyRegistered — comum em Coexistence), este campo fica
  // ausente: não fomos nós que registramos, não inventar uma data.
  registeredAt?: number;
}

export interface EncryptedToken {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

export interface BotConfig {
  // Nome que o bot usa pra se apresentar (padrão "Livia").
  personaName: string;
  // Tom de voz curto que entra no prompt (ex.: "acolhedor e objetivo").
  tone: string;
  // Se true, o bot pode sugerir/registrar agendamentos (fase 2).
  bookingEnabled: boolean;
  // Palavras/intenções que forçam transferência pra humano.
  handoffKeywords: string[];
  // Se true, o bot NUNCA dá orientação clínica/médica (trava p/ clínicas).
  medicalGuardrail: boolean;
}

// ---- Base de conhecimento do estabelecimento ----
// É o que a IA consulta pra responder. Sem isso, ela não inventa.
// "Ensine a Livia" (painel /painel/conhecimento) é a UI guiada por cima
// destes campos — o comerciante nunca vê nome de campo nem prompt técnico,
// só as 7 seções da experiência guiada. Cada campo aqui corresponde 1:1 a
// uma seção; ver lib/ai/brain.ts para como cada um entra no prompt.
export interface KnowledgeBase {
  establishmentId: string;
  about: string; // descrição curta do negócio
  address: string | null;
  hours: string | null; // texto livre: "Seg-Sex 9h-18h, Sáb 9h-13h"
  services: KnowledgeService[];
  faqs: KnowledgeFaq[];
  // Texto adicional livre (políticas, convênios, regras diversas...).
  notes: string | null;
  // Formas de pagamento aceitas, em texto livre (ex.: "Pix, dinheiro, cartão").
  paymentMethods: string | null;
  // Informações que o cliente precisa saber antes de vir (documentos,
  // chegar com antecedência, etc.).
  importantInfo: string | null;
  // Como a Livia deve conversar (tom, estilo, o que fazer). Complementa
  // BotConfig.tone com orientação mais rica e específica do negócio.
  toneGuidelines: string | null;
  // O que a Livia NUNCA deve fazer (além do medicalGuardrail, que é uma
  // trava estrutural separada — isto é orientação adicional em texto livre).
  prohibitions: string | null;
  // Situações em que a Livia deve chamar um humano, em linguagem natural
  // (ex.: "cliente irritado", "pedido de desconto") — julgamento semântico
  // da IA, complementar a BotConfig.handoffKeywords (que é match literal de
  // palavra-chave). Os dois mecanismos coexistem, nenhum substitui o outro.
  handoffTriggers: string | null;
  updatedAt: number;
}

export interface KnowledgeService {
  name: string;
  priceText: string | null; // "a partir de R$ 80" — texto, não número
  durationText: string | null; // "40 min"
  description: string | null;
}

export interface KnowledgeFaq {
  question: string;
  answer: string;
}

// ---- Conversas ----
// Uma conversa por contato (número do cliente). Guardamos as últimas
// mensagens pra dar contexto à IA (janela deslizante).
export interface Conversation {
  id: string; // = telefone normalizado do cliente
  establishmentId: string;
  contactPhone: string;
  contactName: string | null;
  // "bot" = Livia atendendo · "handoff" = Livia identificou que precisa de
  // humano e PAROU de responder automaticamente, mas ainda ninguém assumiu ·
  // "human" = um atendente assumiu a conversa (assumir/devolver no painel) ·
  // "closed" = reservado para uso futuro.
  status: "bot" | "handoff" | "human" | "closed";
  lastMessageAt: number;
  createdAt: number;
  // Última intenção detectada na mensagem mais recente do cliente. É
  // SOBRESCRITA a cada mensagem nova — não serve como evidência de que a
  // conversa teve um objetivo, só do que foi dito por último.
  lastIntent?: IntentType;
  // Quando uma intenção de AGENDAR/REMARCAR apareceu nesta conversa pela
  // última vez. Existe porque `lastIntent` sozinho perde essa informação: um
  // agendamento real leva várias mensagens ("Agenda pra amanhã às 9" →
  // "Avaliação"), e a última quase nunca carrega a palavra-chave — o funil
  // (Passo 12/13) via a conversa como se nunca tivesse havido intenção de
  // agendar. Este carimbo nunca é apagado por uma mensagem posterior.
  lastScheduleIntentAt?: number;
  // Etapa da tarefa em andamento (ex.: agendamento) — ausente quando não há
  // tarefa ativa.
  task?: ConversationTask;
  // Resumo curto e estruturado, gerado só em momentos relevantes (handoff ou
  // agendamento concluído — nunca a cada mensagem, por custo). Alimenta o
  // atendimento humano e a continuidade numa próxima conversa.
  summary?: string;
  summaryUpdatedAt?: number;
}

// ---- Agenda ----
export type AppointmentStatus =
  | "pending" // criado, aguardando confirmação do cliente
  | "confirmed" // cliente confirmou
  | "cancelled"
  | "completed"
  | "no_show"; // não compareceu

export interface Appointment {
  id: string;
  establishmentId: string;
  contactPhone: string;
  contactName: string | null;
  serviceName: string;
  startAt: number; // epoch ms (UTC)
  durationMin: number;
  status: AppointmentStatus;
  source: "bot" | "manual";
  note: string | null;
  createdAt: number;
  confirmedAt: number | null;
  reminderSentAt: number | null;
  // Quando o status virou "cancelled" (lib/scheduling.ts: setStatus).
  // Ausente em documentos criados antes deste campo existir — tratado como
  // "não sabemos quando" em qualquer métrica que dependa disso (nunca
  // aproximado a partir de outro campo), nunca contado como cancelamento de
  // hoje sem essa evidência.
  cancelledAt?: number | null;
}

export interface DayHours {
  open: string; // "09:00"
  close: string; // "18:00"
  breaks?: { start: string; end: string }[]; // ex.: almoço
}

// Configuração da agenda do estabelecimento.
export interface ScheduleConfig {
  establishmentId: string;
  timezone: string; // exibição (ex.: "America/Sao_Paulo")
  // Offset fixo usado nos cálculos (Brasil não tem horário de verão: -180).
  utcOffsetMinutes: number;
  slotMinutes: number; // granularidade dos horários (ex.: 30)
  defaultDurationMin: number; // duração padrão de um atendimento
  leadHours: number; // antecedência mínima pra marcar (ex.: 2h)
  // Horários por dia da semana: "0"=domingo ... "6"=sábado. null = fechado.
  days: Record<string, DayHours | null>;
  // Template aprovado usado no lembrete (envio fora da janela de 24h exige HSM).
  reminderTemplateName: string | null;
  reminderTemplateLang: string;
  updatedAt: number;
}

// ---- Inteligência: memória do cliente, intenção e estado da tarefa ----
// (docs/ORDEM-IMPLEMENTACAO-INTELIGENCIA.md, Fases 1-5)

// Perfil persistente por cliente, dentro de cada tenant — o que a Livia
// "lembra" de um cliente recorrente. Guarda FATOS, nunca o histórico de
// conversa (isso já vive em Conversation/Message). Todo campo aqui só é
// escrito com dado determinístico (nome do contato do WhatsApp, serviço de
// um agendamento realmente criado, intenção de um classificador
// determinístico) — nunca por inferência da IA, que poderia registrar um
// "fato" errado como se fosse confiável. Documento: establishments/{id}/customers/{telefone normalizado}.
export interface CustomerProfile {
  phone: string; // telefone normalizado, mesmo id de Conversation
  establishmentId: string;
  name: string | null;
  preferredProfessional: string | null;
  preferredTime: string | null;
  frequentAddress: string | null;
  lastService: string | null;
  lastIntent: IntentType | null;
  notes: string | null; // observação livre, só editável manualmente (painel futuro) — nunca escrita pela IA
  lastInteractionAt: number;
  createdAt: number;
  updatedAt: number;
}

// Objetivo principal detectado numa mensagem do cliente. Classificação
// DETERMINÍSTICA (palavras-chave/regex em lib/ai/intent.ts) — sem custo de
// IA. `confidence` reflete a força do sinal léxico, não uma probabilidade de
// modelo.
export type IntentType =
  | "schedule_appointment"
  | "reschedule_appointment"
  | "cancel_appointment"
  // Pergunta sobre um agendamento QUE JÁ EXISTE ("tenho consulta hoje?",
  // "qual horário marquei?"). Diferente de schedule_appointment: aqui o
  // cliente não quer marcar nada, quer saber o que já está marcado. Esta
  // intenção OBRIGA o backend a consultar a agenda antes de gerar a
  // resposta (ver lib/ai/brain.ts) — não é uma sugestão ao modelo.
  | "check_appointment"
  | "ask_price"
  | "ask_hours"
  | "ask_address"
  | "human_handoff"
  | "complaint"
  | "general_question";

export interface Intent {
  type: IntentType;
  confidence: number; // 0–1
  entities: Record<string, string>;
}

// Em qual etapa de uma tarefa em andamento (hoje só agendamento) a conversa
// está — permite continuar sem recomeçar do zero numa mensagem seguinte.
// Persistido em Conversation.task; limpo quando a tarefa conclui (agendamento
// criado) ou é abandonada por uma intenção nova incompatível.
export type TaskState =
  | "collect_service"
  | "collect_date"
  | "check_availability"
  | "offer_options"
  | "confirm"
  | "create_appointment";

export interface ConversationTask {
  type: "schedule_appointment" | "reschedule_appointment" | "cancel_appointment";
  state: TaskState;
  collectedData: Record<string, string | number>;
  missingData: string[];
  updatedAt: number;
}

// ---- Ensinar a Lívia (Passo 8) ----
// Correção feita pelo dono via painel. Sempre aplicada a
// KnowledgeBase.faqs (categoria "faq") ou anexada a KnowledgeBase.notes
// (demais categorias) — nunca escreve em Establishment, whatsapp,
// Appointment ou qualquer dado de integração: estruturalmente, o código que
// aplica uma correção só importa funções de conhecimento (ver
// lib/repo.ts: applyKnowledgeCorrection). O documento aqui é o registro
// histórico/auditável de que a correção aconteceu.
export type CorrectionCategory =
  | "faq"
  | "establishment_info"
  | "business_rule"
  | "communication_preference"
  | "operational_knowledge";

export interface KnowledgeCorrection {
  id: string;
  establishmentId: string;
  category: CorrectionCategory;
  // Só relevante pra "faq" — a pergunta que a resposta errada não respondeu
  // bem. Nas outras categorias, fica null.
  question: string | null;
  correctText: string;
  // Conversa que originou a correção, quando iniciada de lá — não é
  // referência viva (a conversa pode ser limpa depois; isto é só contexto).
  conversationId: string | null;
  createdAt: number;
}

// ---- Fila de pendências (Passo 9) ----
// Uma conversa tem, no máximo, UMA pendência ativa por vez nesta V1 — por
// isso o id do documento é o PRÓPRIO conversationId: reavaliar a mesma
// conversa em mensagens seguintes atualiza o mesmo documento (nunca cria um
// novo), o que é a deduplicação exigida pelo plano sem precisar de query.
export type PendingTaskType =
  | "awaiting_customer_confirmation"
  | "awaiting_information"
  | "awaiting_human"
  | "appointment_started_incomplete"
  | "exception_needs_establishment";

export type PendingTaskStatus = "open" | "resolved";

export interface PendingTask {
  id: string; // = conversationId
  establishmentId: string;
  conversationId: string;
  contactPhone: string;
  type: PendingTaskType;
  waitingFor: string; // descrição curta e legível (ex.: "cliente confirmar o horário")
  status: PendingTaskStatus;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  dueAt: number | null;
}

// ---- Caixa de entrada inteligente (Passo 11) ----
// Classificação DERIVADA na hora da leitura (status/lastIntent/task/
// pendingTask já existentes) — nunca persistida, nunca uma fonte de verdade
// paralela. Ver lib/ai/inbox.ts.
export type InboxCategory =
  | "needs_human" // handoff ativo ou pendingTask awaiting_human
  | "customer_waiting" // pendingTask awaiting_customer_confirmation
  | "appointment_incomplete" // pendingTask appointment_started_incomplete
  | "opportunity" // pendingTask exception_needs_establishment, ou outra oportunidade detectada
  | "complaint" // intenção "complaint" nesta conversa
  | "resolved"; // nada pendente

// ---- Oportunidades e funil (Passo 12) ----
// SEMPRE derivada de dados que já existem (pendingTasks, Intent,
// Appointment) — nunca persistida como fato novo, nunca gerada por IA.
// `evidence` é obrigatório e sempre aponta pra um dado concreto (nunca um
// texto "explicando" livremente) — é o que impede falso positivo silencioso.
export type OpportunityType =
  | "handoff_waiting"
  | "appointment_incomplete"
  | "awaiting_confirmation"
  | "complaint_unresolved"
  | "price_inquiry_no_booking"
  | "cancelled_no_rebooking";

export interface Opportunity {
  type: OpportunityType;
  conversationId: string;
  contactPhone: string;
  contactName: string | null;
  label: string; // curto, pra UI
  evidence: string; // de onde veio (nome de campo/coleção), não texto de IA
  detectedAt: number;
}

export type MessageRole = "customer" | "bot" | "agent";

export interface Message {
  id: string;
  role: MessageRole;
  text: string;
  at: number;
  // ID da mensagem na Meta (pra dedupe de webhook e status de entrega).
  waMessageId?: string;
}
