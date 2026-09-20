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
  items?: { name: string; quantity: number; variant?: string | null; modifiers?: string[]; notes?: string | null; lineTotalCents?: number }[];
  subtotalCents?: number;
  discountCents?: number;
  deliveryFeeCents?: number;
  fulfillment?: "pickup" | "delivery" | null;
  deliveryAddress?: { raw: string; neighborhood: string | null; reference: string | null } | null;
  payment?: { method: string | null } | null;
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

// A frase de fechamento é montada exclusivamente do retorno canônico da
// ferramenta. Ela não depende de o modelo repetir corretamente item, taxa ou
// total antes de pedir o "sim" do cliente.
export function composeOrderConfirmationRequest(order: OrderSummaryForReply): string | null {
  const items = order.items ?? [];
  if (!items.length || typeof order.totalCents !== "number") return null;
  const lines = items.map((item) => {
    const details = [item.variant, ...(item.modifiers ?? []), item.notes ? `obs.: ${item.notes}` : null].filter(Boolean).join(", ");
    const value = typeof item.lineTotalCents === "number" ? ` — ${brl(item.lineTotalCents)}` : "";
    return `• ${item.quantity}x ${item.name}${details ? ` (${details})` : ""}${value}`;
  });
  const fulfillment = order.fulfillment === "delivery" ? `Entrega${order.deliveryAddress ? `: ${order.deliveryAddress.raw}` : ""}` : "Retirada no local";
  const payment = order.payment?.method ? `Pagamento: ${order.payment.method}.` : "";
  return [
    "Confira seu pedido:",
    ...lines,
    typeof order.subtotalCents === "number" ? `Subtotal: ${brl(order.subtotalCents)}.` : "",
    typeof order.discountCents === "number" && order.discountCents > 0 ? `Desconto: ${brl(order.discountCents)}.` : "",
    typeof order.deliveryFeeCents === "number" ? `Taxa de entrega: ${brl(order.deliveryFeeCents)}.` : "",
    `Total: ${brl(order.totalCents)}.`,
    fulfillment,
    payment,
    "Se estiver tudo certo, responda “confirmo” ou “pode fechar”.",
  ].filter(Boolean).join("\n");
}
