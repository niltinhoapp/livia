import type { CampaignTemplateSnapshot } from "@/types";
import type { WhatsAppTemplate } from "@/lib/whatsapp/client";

/** Campanhas V1 não possui preenchimento de parâmetros de template. */
export function templateRequiresParameters(components: ReadonlyArray<{ text?: unknown }> | undefined): boolean {
  return Boolean(components?.some((component) => typeof component.text === "string" && /\{\{\d+\}\}/.test(component.text)));
}

export function isCampaignTemplateCompatible(template: WhatsAppTemplate): boolean {
  return template.approved && template.senderCompatible && !templateRequiresParameters(template.components);
}

export function campaignTemplateSnapshot(template: WhatsAppTemplate): CampaignTemplateSnapshot {
  return {
    id: template.id,
    name: template.name,
    languageCode: template.language,
    status: template.status,
    category: template.category,
    components: template.components,
    senderCompatible: template.senderCompatible,
  };
}

export function matchesCampaignTemplate(snapshot: CampaignTemplateSnapshot, template: WhatsAppTemplate): boolean {
  return snapshot.id === template.id && snapshot.name === template.name && snapshot.languageCode === template.language;
}
