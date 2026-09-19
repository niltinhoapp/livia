import type { CampaignTemplateParameterBinding, CampaignTemplateSnapshot } from "@/types";
import type { WhatsAppTemplate } from "@/lib/whatsapp/client";

export function templateParameterIndexes(components: ReadonlyArray<{ type?: unknown; text?: unknown }> | undefined): number[] {
  const indexes = new Set<number>();
  for (const component of components ?? []) {
    if (String(component.type).toUpperCase() !== "BODY" || typeof component.text !== "string") continue;
    for (const match of component.text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) indexes.add(Number(match[1]));
  }
  return [...indexes].filter((index) => Number.isInteger(index) && index > 0).sort((a, b) => a - b);
}

export function isCampaignTemplateCompatible(template: WhatsAppTemplate): boolean {
  return template.approved && template.senderCompatible;
}

export function templateParameterBindingsAreValid(
  components: ReadonlyArray<{ type?: unknown; text?: unknown }> | undefined,
  bindings: CampaignTemplateParameterBinding[] | undefined,
): boolean {
  const indexes = templateParameterIndexes(components);
  if (indexes.length === 0) return !bindings || bindings.length === 0;
  if (!bindings || bindings.length !== indexes.length) return false;
  const byIndex = new Map(bindings.map((binding) => [binding.index, binding]));
  if (byIndex.size !== indexes.length || indexes.some((index) => !byIndex.has(index))) return false;
  return indexes.every((index) => {
    const binding = byIndex.get(index)!;
    if (binding.source === "customer_name") return index === 1;
    return binding.source === "fixed" && binding.value.trim().length > 0 && binding.value.trim().length <= 1024;
  });
}

export function resolveCampaignTemplateParams(snapshot: CampaignTemplateSnapshot, customerName?: string | null): string[] | null {
  const indexes = templateParameterIndexes(snapshot.components);
  if (indexes.length === 0) return [];
  if (!templateParameterBindingsAreValid(snapshot.components, snapshot.parameterBindings)) return null;
  const byIndex = new Map(snapshot.parameterBindings!.map((binding) => [binding.index, binding]));
  return indexes.map((index) => {
    const binding = byIndex.get(index)!;
    return binding.source === "customer_name" ? customerName?.trim() || "cliente" : binding.value.trim();
  });
}

export function campaignTemplateSnapshot(
  template: WhatsAppTemplate,
  parameterBindings?: CampaignTemplateParameterBinding[],
): CampaignTemplateSnapshot {
  return {
    id: template.id,
    name: template.name,
    languageCode: template.language,
    status: template.status,
    category: template.category,
    components: template.components,
    senderCompatible: template.senderCompatible,
    ...(parameterBindings?.length ? { parameterBindings } : {}),
  };
}

export function matchesCampaignTemplate(snapshot: CampaignTemplateSnapshot, template: WhatsAppTemplate): boolean {
  return snapshot.id === template.id && snapshot.name === template.name && snapshot.languageCode === template.language;
}
