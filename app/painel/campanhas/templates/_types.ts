// Tipo FRONT-ONLY — não existe ainda no domínio real (types/index.ts só tem
// CampaignTemplateSnapshot, um retrato mínimo). Fica isolado aqui, claramente
// marcado, para nunca ser confundido com contrato de backend real.
// BACKEND CONTRACT NEEDED: GET /api/campaigns/templates -> { templates: Template[] }
export type TemplateStatus = "approved" | "in_review" | "rejected";

export interface Template {
  id: string;
  name: string;
  category: string;
  languageCode: string;
  status: TemplateStatus;
  previewBody: string;
}

export const TEMPLATE_STATUS_LABEL: Record<TemplateStatus, { label: string; tone: "success" | "warning" | "danger" }> = {
  approved: { label: "Aprovado", tone: "success" },
  in_review: { label: "Em análise", tone: "warning" },
  rejected: { label: "Rejeitado", tone: "danger" },
};
