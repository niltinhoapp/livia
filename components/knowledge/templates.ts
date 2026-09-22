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
  {
    id: "restaurante",
    label: ESTABLISHMENT_TYPE_LABELS.restaurante,
    matchesTypes: ["restaurante"],
    about:
      "Somos um restaurante com comida caseira, opções executivas e pratos à la carte. Atendemos no salão, para viagem com retirada no local e delivery, com foco em refeições saborosas e ingredientes frescos.",
    services: [
      { name: "Prato executivo do dia", priceText: "a partir de R$ 28", durationText: null, description: "Acompanha arroz, feijão, proteína à escolha e salada fresca" },
      { name: "Marmitex tradicional", priceText: "a partir de R$ 22", durationText: null, description: "Tamanhos P, M e G disponíveis para retirada ou entrega" },
      { name: "Prato à la carte (2 pessoas)", priceText: "conforme cardápio", durationText: null, description: "Opções completas para compartilhar com a família" },
      { name: "Bebidas e sobremesas", priceText: "conforme cardápio", durationText: null, description: "Sucos naturais, refrigerantes e sobremesas da casa" },
    ],
    paymentMethods: "Aceitamos Pix, dinheiro, cartões de débito e crédito, e vales-refeição (Alelo, Sodexo, VR e Ticket).",
    importantInfo:
      "Atendimento presencial no salão, retirada no balcão e delivery. Tempo médio de entrega entre 40 e 60 minutos. Taxa de entrega calculada de acordo com o bairro/endereço. Para reservas de mesas ou eventos com mais de 6 pessoas, consulte a nossa equipe. O cardápio completo com preços e disponibilidade atualizados é gerenciado no painel oficial de pedidos.",
    toneGuidelines:
      "Seja acolhedora, cordial e ágil. Mensagens curtas e objetivas. Chame o cliente pelo primeiro nome. Apresente as opções do dia com entusiasmo e oriente o cliente a consultar o cardápio oficial para montar o pedido.",
    prohibitions:
      "Não inventar pratos, preços ou promoções fora do cardápio oficial. Não prometer tempo de entrega menor que o padrão da cozinha em horários de pico. Não confirmar reservas de grandes mesas sem validação da equipe.",
    handoffTriggers:
      "Reclamação sobre pedido atrasado, trocado ou incompleto. Solicitação de cancelamento de pedido já em preparo. Reservas para grandes grupos ou eventos. Dúvidas críticas sobre alergias alimentares ou restrições severas.",
  },
  {
    id: "lanchonete",
    label: ESTABLISHMENT_TYPE_LABELS.lanchonete,
    matchesTypes: ["lanchonete"],
    about:
      "Somos uma lanchonete especializada em salgados fresquinhos, sanduíches rápidos, sucos naturais e combos promocionais. Atendimento rápido no balcão, para viagem ou entregue no conforto da sua casa.",
    services: [
      { name: "Salgados fritos e assados", priceText: "a partir de R$ 8", durationText: null, description: "Coxinhas, empadas, esfihas, pastéis e folhados fresquinhos" },
      { name: "Lanches e tostex", priceText: "a partir de R$ 14", durationText: null, description: "Misto quente, bauru, lanches naturais e opções no pão francês" },
      { name: "Sucos naturais e vitaminas", priceText: "a partir de R$ 9", durationText: null, description: "Frutas da estação preparadas na hora com água ou leite" },
      { name: "Combo lanche + bebida", priceText: "conforme cardápio", durationText: null, description: "Combos econômicos para o café da manhã ou lanche da tarde" },
    ],
    paymentMethods: "Aceitamos Pix, cartões de débito, crédito e dinheiro (favor avisar se precisar de troco).",
    importantInfo:
      "Consumo no local, retirada rápida no balcão e delivery. Tempo médio de entrega entre 30 e 50 minutos. Para encomendas de salgadinhos de festa em grande quantidade, fazer o pedido com pelo menos 24 horas de antecedência.",
    toneGuidelines:
      "Seja animada, prática e prestativa. Use mensagens curtas e diretas. Ajude o cliente a escolher o lanche ou combo ideal de forma rápida e eficiente.",
    prohibitions:
      "Não inventar itens fora do cardápio oficial. Não prometer entrega rápida imediata em horários de pico sem validar com a cozinha. Não aceitar encomendas grandes para entrega no mesmo dia sem confirmação da equipe.",
    handoffTriggers:
      "Pedido com item trocado, esquecido ou atrasado. Pedidos corporativos ou grandes encomendas de salgados para festas. Pedido de desconto ou cancelamento.",
  },
  {
    id: "pizzaria",
    label: ESTABLISHMENT_TYPE_LABELS.pizzaria,
    matchesTypes: ["pizzaria"],
    about:
      "Somos uma pizzaria artesanal com massa de fermentação lenta, bordas recheadas e ingredientes selecionados. Oferecemos pizzas salgadas tradicionais, especiais e doces para delivery ou retirada no balcão.",
    services: [
      { name: "Pizza tradicional grande (8 fatias)", priceText: "a partir de R$ 50", durationText: null, description: "Sabores clássicos como Calabresa, Mussarela, Portuguesa e Margherita" },
      { name: "Pizza especial grande", priceText: "a partir de R$ 65", durationText: null, description: "Receitas exclusivas com queijos nobres e ingredientes especiais" },
      { name: "Pizza doce brotinho (4 fatias)", priceText: "a partir de R$ 35", durationText: null, description: "Chocolate com morango, Nutella com ninho e Romeu e Julieta" },
      { name: "Borda recheada", priceText: "a partir de R$ 12", durationText: null, description: "Catupiry original, Cheddar cremoso ou Chocolate" },
    ],
    paymentMethods: "Aceitamos Pix, cartões de crédito e débito na entrega/retirada e dinheiro (informe o valor do troco).",
    importantInfo:
      "Permitimos pizzas meio a meio (até 2 sabores por pizza grande). Tempo médio de forno e entrega de 40 a 60 minutos (de sexta a domingo e feriados pode variar conforme o movimento). Taxa de entrega varia por região. O cardápio oficial com opções e adicionais está disponível no sistema.",
    toneGuidelines:
      "Seja calorosa, ágil e muito atenciosa. Deixe o cliente à vontade para escolher sabores e bordas. Confirme com precisão o endereço de entrega, o ponto de referência e a forma de pagamento.",
    prohibitions:
      "Não prometer mais de 2 sabores na mesma pizza grande. Não inventar sabores ou preços fora do cardápio oficial. Não prometer entrega em menos de 30 minutos em dias de alta demanda.",
    handoffTriggers:
      "Pizza entregue revirada, fria ou com sabor divergente do pedido. Atraso superior a 20 minutos além do prazo estimado. Pedido de cancelamento após a pizza ter entrado no forno.",
  },
  {
    id: "hamburgueria",
    label: ESTABLISHMENT_TYPE_LABELS.hamburgueria,
    matchesTypes: ["hamburgueria"],
    about:
      "Somos uma hamburgueria artesanal com foco em smash burgers crocantes, burgers artesanais grelhados, pães especiais, molhos da casa e porções crocantes de batata frita.",
    services: [
      { name: "Smash burger clássico", priceText: "a partir de R$ 26", durationText: null, description: "Prensado na chapa com crostinha perfeita, queijo derretido e pão brioche" },
      { name: "Burger artesanal especial (180g)", priceText: "a partir de R$ 34", durationText: null, description: "Blend bovino suculento, bacon crocante, queijo especial e molho da casa" },
      { name: "Batata frita crocante", priceText: "a partir de R$ 18", durationText: null, description: "Porção individual ou para compartilhar, com opção de cheddar e bacon" },
      { name: "Combo burger + fritas + bebida", priceText: "conforme cardápio", durationText: null, description: "Refeição completa e econômica com refrigerante ou suco" },
    ],
    paymentMethods: "Aceitamos Pix, cartões de débito, crédito e dinheiro.",
    importantInfo:
      "Burgers montados na hora com ingredientes frescos. Ponto padrão da carne: ao ponto (bem suculento). Tempo médio de preparo e entrega entre 35 e 55 minutos. Embalagens térmicas individuais para garantir crocância e temperatura.",
    toneGuidelines:
      "Seja moderna, descontraída e rápida. Linguagem jovem, simpática e objetiva. Chame o cliente pelo primeiro nome e tire dúvidas sobre os burgers, molhos e adicionais.",
    prohibitions:
      "Não inventar ingredientes, blends ou adicionais que não constem no cardápio oficial. Não aceitar alterações complexas de receita sem validar com a chapa. Não prometer troco sem o cliente especificar o valor.",
    handoffTriggers:
      "Pedido entregue incompleto (falta de molho, batata ou refrigerante). Burger entregue frio ou trocado. Atraso excessivo da entrega. Solicitação de cancelamento ou estorno.",
  },
];

export function suggestedTemplateFor(type: EstablishmentType): KnowledgeTemplate | null {
  return KNOWLEDGE_TEMPLATES.find((t) => t.matchesTypes.includes(type)) ?? null;
}
