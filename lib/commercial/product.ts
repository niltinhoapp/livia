// Fonte de verdade do DISCURSO comercial. Os fluxos de cobrança continuam
// autoritativos para criar assinatura e confirmar pagamento; estes fatos são
// somente leitura e espelham o plano único exibido em /painel/plano e cobrado
// pelas rotas de billing existentes.
export const LIVIA_COMMERCIAL_PRODUCT = {
  name: "Lívia",
  monthlyPriceCents: 12_900,
  trialDays: 7,
  billingCycle: "monthly" as const,
  capabilities: {
    whatsappService: "atendimento automático no WhatsApp com base nas informações configuradas pela empresa",
    questions: "respostas a dúvidas usando a base de conhecimento do estabelecimento",
    scheduling: "consulta de horários, agendamento, confirmação, remarcação e cancelamento quando a agenda está habilitada",
    handoff: "transferência para atendimento humano quando necessário",
    audio: "entendimento e resposta a mensagens de áudio quando o recurso está habilitado",
    orders: "consulta de cardápio e montagem de pedidos para operações de alimentação configuradas",
    menuSetup: "cardápio manual ou importado por imagens JPG, PNG ou WEBP, com revisão antes de publicar",
  },
} as const;

export function formatCommercialPrice(cents: number = LIVIA_COMMERCIAL_PRODUCT.monthlyPriceCents): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: 0 }).format(cents / 100);
}

export function commercialProductFacts(): string[] {
  const product = LIVIA_COMMERCIAL_PRODUCT;
  return [
    `Produto: ${product.name}, assistente virtual com IA para atendimento no WhatsApp.`,
    `Plano atual: ${formatCommercialPrice()} por mês.`,
    `Período gratuito: ${product.trialDays} dias.`,
    `Capacidades reais: ${Object.values(product.capabilities).join("; ")}.`,
    "A contratação, ativação e confirmação de pagamento só existem quando o backend correspondente confirmar. A conversa nunca prova contratação.",
  ];
}

export function commercialPriceReply(): string {
  return `A Lívia custa ${formatCommercialPrice()} por mês e tem ${LIVIA_COMMERCIAL_PRODUCT.trialDays} dias gratuitos para experimentar. Se quiser, posso explicar como funciona a contratação.`;
}

export const COMMERCIAL_MENU_IMPORT_FACT = "O cardápio pode ser cadastrado manualmente ou importado por imagens JPG, PNG ou WEBP. Antes de publicar, você revisa os itens reconhecidos. CSV, Excel, PDF e importação por link não são suportados hoje.";
