// Modelos iniciais de "Ensine a Livia" por segmento — só texto de exemplo
// pronto pra usar, nunca aplicado automaticamente (ver app/painel/
// conhecimento/page.tsx: o comerciante escolhe explicitamente "Usar este
// modelo", e só preenche campos que ainda estão vazios).
import type { EstablishmentType, KnowledgeService } from "@/types";
import { ESTABLISHMENT_TYPE_LABELS } from "@/components/lib/labels";

export interface KnowledgeTemplate {
  id: string;
  label: string;
  // Segmentos (EstablishmentType) para os quais este modelo é sugerido
  // automaticamente primeiro, quando o estabelecimento já tem o tipo
  // cadastrado em Configurações.
  matchesTypes: EstablishmentType[];
  about: string;
  services: KnowledgeService[];
  paymentMethods: string;
  importantInfo: string;
  toneGuidelines: string;
  prohibitions: string;
  handoffTriggers: string;
}

export interface KnowledgeFormData {
  about: string;
  services: KnowledgeService[];
  paymentMethods: string;
  importantInfo: string;
  toneGuidelines: string;
  prohibitions: string;
  handoffTriggers: string;
}

// Só preenche o que estiver vazio — nunca sobrescreve o que já existe.
export function mergeTemplateIntoKnowledge(
  current: KnowledgeFormData,
  template: KnowledgeTemplate
): KnowledgeFormData {
  return {
    about: current.about.trim() ? current.about : template.about,
    services: current.services.length > 0 ? current.services : template.services,
    paymentMethods: current.paymentMethods.trim() ? current.paymentMethods : template.paymentMethods,
    importantInfo: current.importantInfo.trim() ? current.importantInfo : template.importantInfo,
    toneGuidelines: current.toneGuidelines.trim() ? current.toneGuidelines : template.toneGuidelines,
    prohibitions: current.prohibitions.trim() ? current.prohibitions : template.prohibitions,
    handoffTriggers: current.handoffTriggers.trim() ? current.handoffTriggers : template.handoffTriggers,
  };
}

export const KNOWLEDGE_TEMPLATES: KnowledgeTemplate[] = [
  {
    id: "odontologica",
    label: "Clínica odontológica",
    matchesTypes: ["odonto", "clinica"],
    about:
      "Somos uma clínica odontológica. Atendemos adultos e crianças e buscamos oferecer um atendimento acolhedor.",
    services: [
      { name: "Limpeza", priceText: "R$ 150", durationText: null, description: null },
      { name: "Avaliação", priceText: "R$ 100", durationText: null, description: null },
      { name: "Clareamento", priceText: "a partir de R$ 600", durationText: null, description: null },
      { name: "Implantes", priceText: "valor somente após avaliação", durationText: null, description: null },
    ],
    paymentMethods: "Aceitamos Pix, dinheiro, cartão de débito e crédito.",
    importantInfo: "Para a primeira consulta, trazer documento com foto. Chegar 10 minutos antes.",
    toneGuidelines:
      "Seja simpática e natural. Use mensagens curtas. Chame o cliente pelo primeiro nome. Faça uma pergunta por vez. Evite linguagem excessivamente formal.",
    prohibitions:
      "Não fornecer diagnóstico. Não prescrever medicamentos. Não inventar preços. Não prometer horários sem consultar a agenda.",
    handoffTriggers: "Reclamações. Urgências. Pedido de desconto. Negociação. Cliente irritado.",
  },
  {
    id: "salao_barbearia",
    label: "Salão / Barbearia",
    matchesTypes: ["salao", "estetica"],
    about: "Somos um salão de beleza e barbearia, com foco em atendimento cuidadoso e pontual.",
    services: [
      { name: "Corte de cabelo", priceText: "R$ 50", durationText: null, description: null },
      { name: "Barba", priceText: "R$ 35", durationText: null, description: null },
      { name: "Corte + barba", priceText: "R$ 75", durationText: null, description: null },
      { name: "Coloração", priceText: "a partir de R$ 120", durationText: null, description: null },
    ],
    paymentMethods: "Aceitamos Pix, dinheiro e cartão.",
    importantInfo: "Chegar 5 minutos antes do horário marcado. Em caso de atraso maior que 15 minutos, o horário pode ser remarcado.",
    toneGuidelines: "Seja descontraída e simpática. Mensagens curtas. Chame o cliente pelo primeiro nome.",
    prohibitions: "Não inventar preços. Não prometer horários sem consultar a agenda. Não garantir resultado de coloração sem avaliação prévia.",
    handoffTriggers: "Reclamações sobre o resultado de um serviço. Pedido de desconto. Cliente insatisfeito.",
  },
  {
    id: "pet_shop",
    label: "Pet shop",
    matchesTypes: ["pet"],
    about: "Somos um pet shop com banho, tosa e produtos para cães e gatos.",
    services: [
      { name: "Banho", priceText: "a partir de R$ 60 (conforme porte)", durationText: null, description: null },
      { name: "Tosa", priceText: "a partir de R$ 80 (conforme porte)", durationText: null, description: null },
      { name: "Banho + tosa", priceText: "a partir de R$ 120 (conforme porte)", durationText: null, description: null },
    ],
    paymentMethods: "Aceitamos Pix, dinheiro e cartão.",
    importantInfo: "Trazer a carteirinha de vacinação do pet. Pets agitados podem precisar de mais tempo.",
    toneGuidelines: "Seja alegre e acolhedora. Demonstre carinho pelos pets. Mensagens curtas.",
    prohibitions: "Não dar orientação veterinária. Não inventar preços (variam por porte/raça). Não prometer horário sem consultar a agenda.",
    handoffTriggers: "Dúvida de saúde do animal. Reclamação sobre um atendimento anterior. Pedido de desconto.",
  },
  {
    id: "oficina_mecanica",
    label: ESTABLISHMENT_TYPE_LABELS.oficina,
    matchesTypes: ["oficina"],
    about: "Somos uma oficina mecânica especializada em manutenção preventiva e corretiva de veículos.",
    services: [
      { name: "Troca de óleo", priceText: "a partir de R$ 120 (+ óleo)", durationText: null, description: null },
      { name: "Revisão geral", priceText: "valor após avaliação", durationText: null, description: null },
      { name: "Alinhamento e balanceamento", priceText: "R$ 100", durationText: null, description: null },
    ],
    paymentMethods: "Aceitamos Pix, dinheiro, cartão de débito e crédito.",
    importantInfo: "Trazer o veículo com pelo menos 30 minutos de antecedência para entrada na oficina.",
    toneGuidelines: "Seja direta e objetiva. Explique em linguagem simples, sem termos técnicos desnecessários.",
    prohibitions: "Não dar diagnóstico de defeito sem o carro ser avaliado. Não inventar preço de peça ou serviço. Não prometer prazo sem confirmar com a equipe.",
    handoffTriggers: "Reclamação sobre serviço já feito. Pedido de desconto. Urgência (carro parado na rua).",
  },
  {
    id: "academia",
    label: ESTABLISHMENT_TYPE_LABELS.academia,
    matchesTypes: ["academia"],
    about: "Somos uma academia com musculação, aulas coletivas e acompanhamento profissional.",
    services: [
      { name: "Plano mensal", priceText: "R$ 130/mês", durationText: null, description: null },
      { name: "Plano trimestral", priceText: "R$ 350 (3 meses)", durationText: null, description: null },
      { name: "Aula experimental", priceText: "gratuita", durationText: null, description: null },
    ],
    paymentMethods: "Aceitamos Pix, cartão de débito e crédito (mensalidade recorrente).",
    importantInfo: "Trazer roupa e calçado apropriados para treino. Avaliação física inclusa no primeiro plano.",
    toneGuidelines: "Seja motivadora e energética, sem exagerar. Mensagens curtas.",
    prohibitions: "Não dar orientação de treino ou dieta personalizada sem um profissional. Não inventar preço de plano. Não prometer resultado.",
    handoffTriggers: "Cancelamento de plano. Reclamação. Pedido de desconto ou negociação.",
  },
  {
    id: "imobiliaria",
    label: ESTABLISHMENT_TYPE_LABELS.imobiliaria,
    matchesTypes: ["imobiliaria"],
    about: "Somos uma imobiliária especializada em locação e venda de imóveis residenciais e comerciais.",
    services: [
      { name: "Visita a imóvel", priceText: "gratuita", durationText: null, description: null },
      { name: "Assessoria de locação", priceText: "conforme contrato", durationText: null, description: null },
      { name: "Assessoria de venda", priceText: "conforme contrato", durationText: null, description: null },
    ],
    paymentMethods: "Formas de pagamento variam por imóvel/contrato — confirme com a equipe.",
    importantInfo: "Para agendar visita, informe o imóvel de interesse e documento com foto.",
    toneGuidelines: "Seja profissional e atenciosa. Mensagens curtas. Faça uma pergunta por vez para entender o que o cliente procura.",
    prohibitions: "Não inventar valor de aluguel/venda de imóvel. Não confirmar disponibilidade sem consultar a equipe. Não fechar negociação sozinha.",
    handoffTriggers: "Proposta de valor ou negociação. Dúvida contratual. Reclamação. Interesse concreto em fechar negócio.",
  },
  // ---- Vertical Alimentação ----
  // Na vertical Alimentação, o cardápio oficial, as regras operacionais de pedidos
  // e os horários cadastrados no sistema são as únicas fontes de verdade.
  // Estes modelos fornecem diretrizes de atendimento e postura neutras, sem
  // introduzir itens, preços fictícios ou regras operacionais rígidas na base de conhecimento.
  {
    id: "restaurante",
    label: ESTABLISHMENT_TYPE_LABELS.restaurante,
    matchesTypes: ["restaurante"],
    about:
      "Somos um restaurante com atendimento no salão, retirada no local e delivery. Nosso foco é oferecer refeições de qualidade com bom atendimento. Os pratos, adicionais, opções do dia e preços oficiais são cadastrados e atualizados diretamente no cardápio do sistema de pedidos.",
    services: [],
    paymentMethods:
      "Aceitamos Pix, cartões de crédito e débito, e dinheiro. Consulte nossa equipe sobre bandeiras aceitas e opções de vale-refeição.",
    importantInfo:
      "Atendemos consumo no local, retirada e delivery. Prazos estimados de entrega, taxas de entrega e áreas atendidas seguem a configuração oficial do sistema de pedidos. Para reservas de mesas ou dúvidas sobre ingredientes e alérgenos, consulte nossa equipe.",
    toneGuidelines:
      "Seja acolhedora, cordial e ágil. Use mensagens curtas e claras. Chame o cliente pelo primeiro nome. Ao ser perguntada sobre pratos ou valores, oriente o cliente a consultar o cardápio oficial para montar o pedido.",
    prohibitions:
      "Não inventar pratos, preços, promoções ou ingredientes que não estejam no cardápio oficial. Não prometer prazos de entrega ou valores de taxas diferentes das configurações do sistema. Não confirmar reservas ou fechar pedidos fora do fluxo oficial.",
    handoffTriggers:
      "Reclamação sobre pedido atrasado, trocado ou item faltante. Dúvidas sobre restrições alimentares ou alergias graves. Pedidos especiais ou reservas para grandes grupos. Solicitação de cancelamento de pedido em andamento.",
  },
  {
    id: "lanchonete",
    label: ESTABLISHMENT_TYPE_LABELS.lanchonete,
    matchesTypes: ["lanchonete"],
    about:
      "Somos uma lanchonete com opções de salgados, lanches rápidos, sucos e combos. Atendemos no balcão, para viagem ou entrega. Nossos produtos, adicionais e preços oficiais ficam disponíveis no cardápio do sistema.",
    services: [],
    paymentMethods:
      "Aceitamos Pix, cartões de débito e crédito, e dinheiro (favor informar a necessidade de troco ao confirmar o pagamento).",
    importantInfo:
      "Atendimento para consumo no local, retirada rápida e delivery. Valores de taxa de entrega, raio de entrega e tempo estimado seguem as regras configuradas no sistema de pedidos. Para encomendas com antecedência, consulte nossa equipe.",
    toneGuidelines:
      "Seja animada, prática e prestativa. Use mensagens curtas e diretas. Ajude o cliente a encontrar o que deseja e esclareça dúvidas direcionando para as opções do cardápio oficial.",
    prohibitions:
      "Não inventar itens, valores ou promoções fora do cardápio oficial. Não prometer tempos de entrega não previstos na operação. Não aceitar encomendas personalizadas fora do padrão sem validação da equipe.",
    handoffTriggers:
      "Pedido com item trocado, faltante ou atraso expressivo. Encomendas volumosas para eventos ou empresas. Solicitações de cancelamento ou alteração de pedidos já confirmados.",
  },
  {
    id: "pizzaria",
    label: ESTABLISHMENT_TYPE_LABELS.pizzaria,
    matchesTypes: ["pizzaria"],
    about:
      "Somos uma pizzaria com opções de pizzas salgadas e doces para entrega e retirada no balcão. Nossos sabores, tamanhos, bordas, adicionais e preços são cadastrados no cardápio oficial do sistema.",
    services: [],
    paymentMethods:
      "Aceitamos Pix, cartões de crédito e débito, e dinheiro (favor informar a necessidade de troco ao confirmar o pagamento).",
    importantInfo:
      "Pedidos para entrega ou retirada no local. As regras de montagem de sabores, opções de bordas, tempo estimado e taxa de entrega são definidas e atualizadas nas configurações do sistema de pedidos.",
    toneGuidelines:
      "Seja calorosa, ágil e atenciosa. Deixe o cliente à vontade para escolher sabores e adicionais. Confirme com atenção os dados de entrega e a forma de pagamento conforme apresentados no resumo do pedido.",
    prohibitions:
      "Não inventar sabores, bordas, adicionais ou preços que não estejam no cardápio oficial. Não assumir regras operacionais, limites de sabores ou prazos de entrega que divirjam das configurações cadastradas.",
    handoffTriggers:
      "Problemas na entrega (atraso além do estimado, embalagem danificada ou sabor trocado). Dúvidas sobre ingredientes para clientes alérgicos. Pedidos de cancelamento após confirmação.",
  },
  {
    id: "hamburgueria",
    label: ESTABLISHMENT_TYPE_LABELS.hamburgueria,
    matchesTypes: ["hamburgueria"],
    about:
      "Somos uma hamburgueria artesanal com opções de burgers, porções e bebidas no local, retirada e delivery. Todos os burgers, adicionais, combos e preços oficiais são mantidos atualizados no cardápio do sistema.",
    services: [],
    paymentMethods:
      "Aceitamos Pix, cartões de débito e crédito, e dinheiro. Consulte as formas de pagamento disponíveis no momento de fechar o pedido.",
    importantInfo:
      "Pedidos preparados sob demanda. Taxas de entrega, áreas atendidas e tempo estimado de espera seguem as diretrizes configuradas no sistema de pedidos. Embalagens apropriadas para preservar a qualidade até o destino.",
    toneGuidelines:
      "Seja moderna, descontraída e rápida. Linguagem jovem, simpática e objetiva. Chame o cliente pelo primeiro nome e oriente a consultar o cardápio oficial para escolher burgers, acompanhamentos e bebidas.",
    prohibitions:
      "Não inventar blends, pontos de carne padronizados, adicionais ou preços fora do cardápio oficial. Não prometer tempo de entrega fora da estimativa do sistema. Não fechar pedidos fora do fluxo oficial.",
    handoffTriggers:
      "Pedido entregue incompleto ou com itens trocados. Atraso expressivo na entrega. Dúvidas sobre restrições alimentares. Solicitação de cancelamento ou estorno.",
  },
];

export function suggestedTemplateFor(type: EstablishmentType): KnowledgeTemplate | null {
  return KNOWLEDGE_TEMPLATES.find((t) => t.matchesTypes.includes(type)) ?? null;
}
