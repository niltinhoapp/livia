// Resposta canônica montada a partir do pedido REAL — usada quando o loop de
// ferramentas estoura sem o modelo produzir texto final (ver o fallback em
// lib/ai/brain.ts).
//
// Existe pelo mesmo motivo do fallback da agenda: transferir é a decisão mais
// cara do sistema (a conversa vira "handoff" e a Livia para de responder até
// alguém abrir o painel). Fazer isso com um carrinho já gravado no Firestore
// deixaria o cliente sem saber que o pedido dele está montado. O texto abaixo
// vem sempre do resumo do backend, nunca do modelo.
//
// Módulo puro, sem I/O e sem importar o brain — é o que permite testá-lo
// isoladamente, como os demais resolvedores determinísticos de lib/ai.

export interface OrderSummaryForReply {
  status?: string;
  items?: { name: string; quantity: number; variant?: string | null }[];
  totalCents?: number;
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export function composeOrderReply(order: OrderSummaryForReply): string | null {
  const items = order.items ?? [];
  if (!items.length) return null;
  const linhas = items.map((i) => `${i.quantity}x ${i.name}${i.variant ? ` (${i.variant})` : ""}`).join(", ");
  const total = typeof order.totalCents === "number" ? ` Total: ${brl(order.totalCents)}.` : "";
  if (order.status === "confirmed") {
    return `Pedido confirmado: ${linhas}.${total} Já mandei para a cozinha e te aviso quando estiver pronto.`;
  }
  return `Até aqui seu pedido está assim: ${linhas}.${total} Quer adicionar mais alguma coisa ou pode fechar?`;
}
