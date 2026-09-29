// Configuração do aviso de atendimento humano por estabelecimento. O template
// de WhatsApp é escolhido entre os APROVADOS na WABA do próprio
// estabelecimento e validado na Meta ao salvar — nada é presumido.
import { establishmentRef } from "@/lib/firebase/admin";
import { listMessageTemplates, type WhatsAppTemplate } from "@/lib/whatsapp/client";
import { templateParameterIndexes } from "@/lib/campaignTemplates";
import type { Establishment, HumanHandoffNotificationConfig } from "@/types";

export interface HandoffTemplateOption {
  name: string;
  language: string;
  paramCount: number;
  body: string;
}

// Corpo sem variáveis, com {{1}} (cliente) ou com {{1}} e {{2}} (cliente e
// link da conversa). Qualquer outra combinação não pode ser preenchida.
export function handoffTemplateOption(template: WhatsAppTemplate): HandoffTemplateOption | null {
  if (!template.approved || !template.senderCompatible) return null;
  const indexes = templateParameterIndexes(template.components);
  if (indexes.length > 2 || indexes.some((index, position) => index !== position + 1)) return null;
  const body = template.components.find((c) => c.type.toUpperCase() === "BODY")?.text;
  return { name: template.name, language: template.language, paramCount: indexes.length, body: typeof body === "string" ? body : "" };
}

export async function listHandoffTemplateOptions(establishment: Establishment): Promise<HandoffTemplateOption[]> {
  if (!establishment.whatsapp) return [];
  const templates = await listMessageTemplates(establishment.whatsapp, establishment.id);
  return templates.map(handoffTemplateOption).filter((option): option is HandoffTemplateOption => option !== null);
}

export type HandoffSettingsInput = {
  push?: unknown;
  whatsapp?: unknown;
  responsiblePhone?: unknown;
  templateName?: unknown;
  templateLang?: unknown;
};

export type HandoffSettingsResult =
  | { ok: true; config: HumanHandoffNotificationConfig }
  | { ok: false; status: 400 | 409 | 502; error: string };

export async function saveHandoffSettings(
  establishment: Establishment,
  input: HandoffSettingsInput,
  now = Date.now(),
): Promise<HandoffSettingsResult> {
  const push = input.push === true;
  const whatsapp = input.whatsapp === true;
  const responsiblePhone = String(input.responsiblePhone ?? "").replace(/\D/g, "").slice(0, 15);
  let templateName = "";
  let templateLang = "pt_BR";
  let templateParamCount = 0;

  if (whatsapp) {
    if (responsiblePhone.length < 10) return { ok: false, status: 400, error: "Informe o WhatsApp do responsável com DDI e DDD." };
    if (establishment.whatsapp?.status !== "connected") return { ok: false, status: 409, error: "Conecte o WhatsApp do estabelecimento antes de ativar este aviso." };
    const requestedName = String(input.templateName ?? "").trim();
    const requestedLang = String(input.templateLang ?? "").trim();
    if (!requestedName) return { ok: false, status: 400, error: "Escolha um template aprovado para o aviso por WhatsApp." };
    let options: HandoffTemplateOption[];
    try {
      options = await listHandoffTemplateOptions(establishment);
    } catch {
      return { ok: false, status: 502, error: "Não foi possível consultar seus templates na Meta agora. Tente novamente." };
    }
    const option = options.find((o) => o.name === requestedName && (!requestedLang || o.language === requestedLang));
    if (!option) return { ok: false, status: 400, error: "Template não encontrado entre os aprovados e compatíveis desta conta." };
    templateName = option.name;
    templateLang = option.language;
    templateParamCount = option.paramCount;
  }

  const config: HumanHandoffNotificationConfig = { push, whatsapp, responsiblePhone, templateName, templateLang, templateParamCount, updatedAt: now };
  await establishmentRef(establishment.id).update({ humanHandoffNotifications: config });
  return { ok: true, config };
}
