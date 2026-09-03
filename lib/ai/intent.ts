// Detecção de intenção — Fase 3 de docs/ORDEM-IMPLEMENTACAO-INTELIGENCIA.md.
//
// Deterministica de propósito ("Classificação simples deve usar modelo
// barato ou lógica determinística quando possível"): roda antes de qualquer
// chamada à IA, sem custo de token, e alimenta o estado da tarefa (Fase 4) e
// o prompt do cérebro (Fase 5). Nunca substitui o raciocínio da IA sobre o
// conteúdo da resposta — só dá contexto estrutural de qual é o objetivo
// provável da mensagem.
//
// `confidence` aqui é força de sinal léxico (quantas/quão específicas as
// palavras-chave que bateram), não uma probabilidade calibrada de modelo.
import type { Intent, IntentType } from "@/types";

interface Rule {
  type: IntentType;
  // Cada grupo é testado com `includes`; o primeiro grupo que bater decide o
  // tipo. Ordem importa: regras mais específicas vêm antes das genéricas.
  keywords: string[];
  confidence: number;
}

// Ordem: humano > cancelamento > remarcação > agendamento > perguntas
// factuais > reclamação. Handoff e cancelamento vêm primeiro porque, se
// aparecerem junto de outras palavras (ex. "quero cancelar minha consulta"
// também contém "consulta"), a intenção operacional deve vencer sobre uma
// leitura genérica de agendamento.
const RULES: Rule[] = [
  {
    type: "human_handoff",
    confidence: 0.9,
    keywords: [
      "falar com atendente",
      "falar com alguem",
      "falar com alguém",
      "atendente humano",
      "quero um humano",
      "quero uma pessoa",
      "falar com uma pessoa",
    ],
  },
  {
    type: "cancel_appointment",
    confidence: 0.85,
    keywords: [
      "cancelar minha consulta",
      "cancelar meu horario",
      "cancelar meu horário",
      "cancelar o agendamento",
      "cancelar minha reserva",
      "desmarcar",
      "quero cancelar",
      "nao vou poder ir",
      "não vou poder ir",
      "nao vou conseguir ir",
    ],
  },
  {
    type: "reschedule_appointment",
    confidence: 0.85,
    keywords: [
      "remarcar",
      "reagendar",
      "mudar o horario",
      "mudar o horário",
      "trocar o horario",
      "trocar o horário",
      "trocar a data",
      "mudar a data",
    ],
  },
  {
    type: "schedule_appointment",
    confidence: 0.75,
    keywords: [
      "agendar",
      "marcar um horario",
      "marcar um horário",
      "marcar uma consulta",
      "marcar consulta",
      "marcar hora",
      "quero marcar",
      "tem horario",
      "tem horário",
      "tem vaga",
      "disponibilidade",
      "quero um horario",
      "quero um horário",
    ],
  },
  {
    type: "ask_price",
    confidence: 0.7,
    keywords: ["preço", "preco", "valor", "quanto custa", "quanto é", "quanto fica", "tabela de preço", "tabela de preco"],
  },
  {
    type: "ask_hours",
    confidence: 0.7,
    keywords: ["horario de funcionamento", "horário de funcionamento", "que horas abre", "que horas fecha", "voces abrem", "vocês abrem", "estao abertos", "estão abertos"],
  },
  {
    type: "ask_address",
    confidence: 0.7,
    keywords: ["endereço", "endereco", "onde fica", "onde vocês ficam", "onde voces ficam", "localização", "localizacao", "como chegar"],
  },
  {
    type: "complaint",
    confidence: 0.6,
    keywords: ["reclamação", "reclamacao", "reclamar", "insatisfeito", "insatisfeita", "péssimo", "pessimo", "horrível", "horrivel", "muito ruim"],
  },
];

// Remove acentos pra comparação tolerante (o texto do cliente vem sem
// normalização — "está" e "esta" devem casar com a mesma regra).
const COMBINING_DIACRITICS = /[̀-ͯ]/g;

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(COMBINING_DIACRITICS, "");
}

export function detectIntent(text: string): Intent {
  const normalized = normalize(text);

  for (const rule of RULES) {
    const hit = rule.keywords.find((kw) => normalized.includes(normalize(kw)));
    if (hit) {
      return { type: rule.type, confidence: rule.confidence, entities: {} };
    }
  }

  return { type: "general_question", confidence: 0.3, entities: {} };
}
