// Estabelecimento comercialmente inativo (Establishment.status "suspended").
//
// Antes disto, o webhook fazia `if (est.status !== "active") return;` e o
// cliente final ficava no silêncio absoluto: mandava mensagem e nada
// acontecia, sem nenhum sinal de que algo tinha parado.
//
// Função pura, sem I/O — o webhook decide QUANDO usar; aqui mora só o texto
// e a regra de anti-spam.
import type { Message } from "@/types";

// Neutra de propósito. O cliente final é cliente DO ESTABELECIMENTO, não do
// SaaS: nada sobre trial, assinatura, cobrança, pagamento ou plano, e nada
// que exponha a Livia como fornecedora. Motivo comercial é assunto do dono,
// no painel.
export const SERVICE_PAUSED_REPLY =
  "Oi! No momento o atendimento automático por aqui está pausado. Sua mensagem foi registrada e a equipe responde assim que puder.";

// "oi", "tem alguém?", "oi??", "bom dia" em 20 segundos não podem virar
// quatro respostas idênticas. O dedupe de messageId não cobre isso — são
// mensagens DIFERENTES, cada uma com seu id.
//
// Custo zero: `history` já foi carregado por loadConversation e contém as
// últimas mensagens da conversa, inclusive avisos anteriores da Livia.
//
// Limitação conhecida e aceita: se o cliente mandar mais mensagens do que o
// tamanho do histórico carregado (12), o aviso sai da janela e é reenviado
// uma vez. Preferível a manter estado novo só para isso.
export const SERVICE_PAUSED_COOLDOWN_MS = 60 * 60 * 1000;

export function warnedServicePausedRecently(history: Message[], now: number): boolean {
  return history.some(
    (m) =>
      m.role === "bot" &&
      m.text === SERVICE_PAUSED_REPLY &&
      now - m.at < SERVICE_PAUSED_COOLDOWN_MS,
  );
}
