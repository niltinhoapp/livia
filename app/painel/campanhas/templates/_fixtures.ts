// Fixtures de DEMONSTRAÇÃO VISUAL — só para teste de componente, nunca
// default real (ver _types.ts: nenhum contrato de backend existe ainda).
import type { Template } from "./_types";

export const DEMO_TEMPLATES: Template[] = [
  {
    id: "t1",
    name: "reativacao_30_dias",
    category: "Marketing",
    languageCode: "pt_BR",
    status: "approved",
    previewBody: "Olá {{1}}! Sentimos sua falta. Que tal agendar um horário essa semana? 😊",
  },
  {
    id: "t2",
    name: "aviso_feriado",
    category: "Utilidade",
    languageCode: "pt_BR",
    status: "in_review",
    previewBody: "Olá! Informamos que não abriremos no feriado de {{1}}. Voltamos no dia seguinte!",
  },
  {
    id: "t3",
    name: "promocao_generica",
    category: "Marketing",
    languageCode: "pt_BR",
    status: "rejected",
    previewBody: "Aproveite nossa promoção imperdível!!! Corra!!!",
  },
];
