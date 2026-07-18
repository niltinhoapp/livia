// Tipos centrais da Livia. Espelham as coleções do Firestore.
// Multi-tenant: tudo vive sob establishments/{establishmentId}/...

export type EstablishmentType =
  | "clinica"
  | "pet"
  | "salao"
  | "estetica"
  | "odonto"
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

export interface EstablishmentWhatsapp {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string; // TODO: criptografar em repouso (KMS)
  status: "connected" | "disconnected";
  connectedAt: number;
  tokenRefreshedAt?: number;
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
export interface KnowledgeBase {
  establishmentId: string;
  about: string; // descrição curta do negócio
  address: string | null;
  hours: string | null; // texto livre: "Seg-Sex 9h-18h, Sáb 9h-13h"
  services: KnowledgeService[];
  faqs: KnowledgeFaq[];
  // Texto adicional livre (políticas, formas de pagamento, convênios...).
  notes: string | null;
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
  status: "bot" | "human" | "closed"; // "human" = transferido pro atendente
  lastMessageAt: number;
  createdAt: number;
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
