// Checagem de confiança — Passo 7 do README.md/Plano Mestre.
//
// Função pura e determinística: nenhuma chamada de IA aqui. Decide, a partir
// da intenção já detectada (Passo 3, sem custo) e da base de conhecimento já
// carregada, se existe FONTE interna para o tipo de pergunta operacional —
// e se não existir, devolve uma instrução explícita pro prompt não inventar.
// "Fonte confiável encontrada" pra preço/horário/endereço já é garantida
// estruturalmente pelo prompt (lib/ai/brain.ts só inclui o que está
// cadastrado) — o que faltava era o caso oposto: quando NADA está cadastrado
// e a IA precisa ser instruída a admitir isso em vez de preencher a lacuna
// sozinha.
import type { Intent, KnowledgeBase } from "@/types";

export interface TrustEvaluation {
  hasSource: boolean;
  // Só presente quando hasSource é false — instrução a mais pro prompt,
  // específica da lacuna encontrada.
  directive?: string;
}

// Só os tipos de intenção que pedem um dado factual verificável do próprio
// estabelecimento. As demais (agendamento, cancelamento, handoff, conversa
// geral) não têm uma "fonte única" no mesmo sentido — a IA já tem regras e
// ferramentas próprias para elas.
const CHECKED_INTENTS = new Set(["ask_price", "ask_hours", "ask_address"]);

export function evaluateTrust(intent: Intent, kb: KnowledgeBase | null): TrustEvaluation {
  if (!CHECKED_INTENTS.has(intent.type)) return { hasSource: true };

  if (intent.type === "ask_price") {
    const hasPrice = Boolean(kb?.services?.some((s) => s.priceText)) || Boolean(kb?.faqs?.length);
    if (!hasPrice) {
      return {
        hasSource: false,
        directive:
          "O cliente perguntou sobre preço, mas NENHUM preço está cadastrado na base de conhecimento. NÃO invente um valor — diga que vai confirmar com a equipe e ofereça transferir para um atendente.",
      };
    }
  }

  if (intent.type === "ask_hours" && !kb?.hours) {
    return {
      hasSource: false,
      directive:
        "O cliente perguntou sobre horário de funcionamento, mas NENHUM horário está cadastrado. NÃO invente — diga que vai confirmar com a equipe e ofereça transferir para um atendente.",
    };
  }

  if (intent.type === "ask_address" && !kb?.address) {
    return {
      hasSource: false,
      directive:
        "O cliente perguntou o endereço, mas NENHUM endereço está cadastrado. NÃO invente — diga que vai confirmar com a equipe e ofereça transferir para um atendente.",
    };
  }

  return { hasSource: true };
}
