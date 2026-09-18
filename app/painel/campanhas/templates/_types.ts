export type TemplateStatus = "approved" | "pending" | "rejected" | "other";

export interface Template {
  id: string;
  name: string;
  category: string;
  languageCode: string;
  status: TemplateStatus;
  previewBody: string;
  components: Record<string, unknown>[];
  senderCompatible: boolean;
}

export const TEMPLATE_STATUS_LABEL: Record<TemplateStatus, { label: string; tone: "success" | "warning" | "danger" }> = {
  approved: { label: "Aprovado", tone: "success" },
  pending: { label: "Em análise", tone: "warning" },
  rejected: { label: "Rejeitado", tone: "danger" },
  other: { label: "Indisponível", tone: "warning" },
};
