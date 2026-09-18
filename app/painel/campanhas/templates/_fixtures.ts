// Fixtures de demonstração visual, usadas somente nos testes de componente.
import type { Template } from "./_types";

export const DEMO_TEMPLATES: Template[] = [
  {
    id: "t1",
    name: "reativacao_30_dias",
    category: "Marketing",
    languageCode: "pt_BR",
    status: "approved",
    previewBody: "Olá {{1}}! Sentimos sua falta. Que tal agendar um horário essa semana? 😊",
    components: [{ type: "BODY", text: "Olá {{1}}!" }], senderCompatible: true,
  },
  {
    id: "t2",
    name: "aviso_feriado",
    category: "Utilidade",
    languageCode: "pt_BR",
    status: "pending",
    previewBody: "Olá! Informamos que não abriremos no feriado de {{1}}. Voltamos no dia seguinte!",
    components: [{ type: "BODY", text: "Olá!" }], senderCompatible: true,
  },
  {
    id: "t3",
    name: "promocao_generica",
    category: "Marketing",
    languageCode: "pt_BR",
    status: "rejected",
    previewBody: "Aproveite nossa promoção imperdível!!! Corra!!!",
    components: [{ type: "BODY", text: "Oferta" }], senderCompatible: false,
  },
];
