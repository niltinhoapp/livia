// Modelos iniciais de "Ensine a Livia" por segmento — só texto de exemplo
// pronto pra usar, nunca aplicado automaticamente (ver app/painel/
// conhecimento/page.tsx: o comerciante escolhe explicitamente "Usar este
// modelo", e só preenche campos que ainda estão vazios).
import type { EstablishmentType, KnowledgeService } from "@/types";

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
    matchesTypes: ["salao"],
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
    label: "Oficina mecânica",
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
    label: "Academia",
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
    label: "Imobiliária",
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
];

export function suggestedTemplateFor(type: EstablishmentType): KnowledgeTemplate | null {
  return KNOWLEDGE_TEMPLATES.find((t) => t.matchesTypes.includes(type)) ?? null;
}
