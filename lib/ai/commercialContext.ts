import type {
  AuditConversationData,
  CommercialSegment,
  ConversationContext,
} from "@/types";
import { transitionConversationContext } from "@/lib/ai/conversationPolicy";

const normalize = (value: string) => value
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .toLocaleLowerCase("pt-BR")
  .replace(/\s+/g, " ")
  .trim();

function parseBrazilianNumber(raw: string): number | null {
  const compact = raw.replace(/\s/g, "");
  const normalized = compact.includes(",")
    ? compact.replace(/\./g, "").replace(",", ".")
    : compact.replace(/\.(?=\d{3}(?:\D|$))/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function boundedInteger(raw: string, max: number): number | undefined {
  const value = parseBrazilianNumber(raw);
  return value !== null && Number.isInteger(value) && value <= max ? value : undefined;
}

function moneyCents(raw: string): number | undefined {
  const value = parseBrazilianNumber(raw);
  if (value === null || value > 100_000_000) return undefined;
  return Math.round(value * 100);
}

export function normalizeAuditData(input: unknown, capturedAt: number): AuditConversationData | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const leadsPerDay = typeof raw.leadsPerDay === "number" && Number.isInteger(raw.leadsPerDay) && raw.leadsPerDay >= 0 && raw.leadsPerDay <= 100_000
    ? raw.leadsPerDay
    : undefined;
  const averageTicketCents = typeof raw.averageTicketCents === "number" && Number.isInteger(raw.averageTicketCents) && raw.averageTicketCents >= 0 && raw.averageTicketCents <= 10_000_000_000
    ? raw.averageTicketCents
    : undefined;
  const responseTimeText = typeof raw.responseTimeText === "string" && raw.responseTimeText.trim()
    ? raw.responseTimeText.trim().slice(0, 80)
    : undefined;
  const estimatedOpportunityCentsPerMonth = typeof raw.estimatedOpportunityCentsPerMonth === "number" && Number.isInteger(raw.estimatedOpportunityCentsPerMonth) && raw.estimatedOpportunityCentsPerMonth >= 0 && raw.estimatedOpportunityCentsPerMonth <= 10_000_000_000
    ? raw.estimatedOpportunityCentsPerMonth
    : undefined;
  if (leadsPerDay === undefined && averageTicketCents === undefined && responseTimeText === undefined && estimatedOpportunityCentsPerMonth === undefined) return null;
  return {
    ...(leadsPerDay !== undefined ? { leadsPerDay } : {}),
    ...(averageTicketCents !== undefined ? { averageTicketCents } : {}),
    ...(responseTimeText !== undefined ? { responseTimeText } : {}),
    ...(estimatedOpportunityCentsPerMonth !== undefined ? { estimatedOpportunityCentsPerMonth } : {}),
    capturedAt,
  };
}

// Extração deliberadamente limitada a campos rotulados pela Calculadora.
// Texto livre como "acho que perco 10 mil" nunca vira fato persistido.
export function extractAuditData(text: string, capturedAt: number): AuditConversationData | null {
  const leads = /\bleads?\s+por\s+dia\s*:\s*([\d.,]+)/i.exec(text)?.[1];
  const ticket = /\bticket\s+m[eé]dio\s*:\s*(?:r\$\s*)?([\d.,]+)/i.exec(text)?.[1];
  const response = /\btempo\s+m[eé]dio(?:\s+de\s+resposta)?\s*:\s*(.+?)(?=\s+(?:estimativa(?:\s+apresentada)?|leads?\s+por\s+dia|ticket\s+m[eé]dio)\s*:|$)/i.exec(text)?.[1]?.trim();
  const estimate = /\bestimativa(?:\s+apresentada)?\s*:\s*(?:r\$\s*)?([\d.,]+)/i.exec(text)?.[1];
  return normalizeAuditData({
    leadsPerDay: leads ? boundedInteger(leads, 100_000) : undefined,
    averageTicketCents: ticket ? moneyCents(ticket) : undefined,
    responseTimeText: response?.slice(0, 80),
    estimatedOpportunityCentsPerMonth: estimate ? moneyCents(estimate) : undefined,
  }, capturedAt);
}

export function inferCommercialSegment(text: string): CommercialSegment | null {
  const value = normalize(text);
  if (/\b(pet\s*shop|veterinari[ao]|banho\s+e\s+tosa)\b/.test(value)) return "pet";
  if (/\b(restaurante|lanchonete|pizzaria|delivery|hamburgueria)\b/.test(value)) return "restaurant";
  if (/\b(salao|barbearia|manicure|cabeleireir[oa])\b/.test(value)) return "salon";
  if (/\b(otica|oculos)\b/.test(value)) return "optical";
  if (/\b(clinica|consultorio|dentista|odontologi[ao])\b/.test(value)) return "clinic";
  if (/\b(servicos?|assistencia\s+tecnica|oficina)\b/.test(value)) return "services";
  return null;
}

export function explicitlyQualifiesAudit(text: string): boolean {
  const value = normalize(text);
  return (
    /\b(quero|gostaria|vamos|posso)\b.{0,40}\b(testar|experimentar|contratar)\b/.test(value) ||
    /\b(quero|gostaria)\b.{0,40}\b(ver|fazer|continuar)\b.{0,20}\bdemonstracao\b/.test(value) ||
    /\b(quero|gostaria)\b.{0,40}\bconhecer\b.{0,20}\blivia\b/.test(value)
  );
}

export function asksCommercialProductPrice(text: string): boolean {
  const value = normalize(text);
  const asksPrice = /\b(quanto\s+custa|qual\s+(?:e\s+)?(?:o\s+)?(?:preco|valor)|preco|mensalidade)\b/.test(value);
  if (!asksPrice) return false;
  return /\b(livia|plano|assinatura|mensalidade)\b/.test(value)
    || /^(?:oi[,! ]*)?(?:quanto\s+custa|qual\s+(?:e\s+)?(?:o\s+)?(?:preco|valor)|preco)[?!. ]*$/.test(value);
}

// Em demonstração de restaurante, separa uma pergunta sobre item do catálogo
// da pergunta genérica sobre o preço da própria Lívia. A busca continua sendo
// executada pela tool oficial da F2; isto apenas extrai uma consulta curta e
// explícita, sem inferir produto que a pessoa não citou.
export function extractCatalogPriceQuery(text: string): string | null {
  const match = /(?:quanto\s+custa|qual\s+(?:é\s+)?o\s+preço|preço)\s+(?:d[oa]\s+|(?:o|a)\s+)?([^?!.]{1,80})/i.exec(text);
  const query = match?.[1]?.trim().replace(/["'“”]+/g, "") ?? "";
  return query || null;
}

export function enrichCommercialContext(input: {
  context: ConversationContext;
  text: string;
  now: number;
  allowAuditQualification: boolean;
}): { context: ConversationContext; changed: boolean; auditQualified: boolean } {
  const { text, now } = input;
  let context = input.context;
  let changed = false;

  if (context.purpose === "audit") {
    const extracted = extractAuditData(text, now);
    if (extracted) {
      const merged = { ...context.audit, ...extracted, capturedAt: context.audit?.capturedAt ?? extracted.capturedAt };
      if (JSON.stringify(merged) !== JSON.stringify(context.audit)) {
        context = { ...context, audit: merged, updatedAt: now };
        changed = true;
      }
    }
  }

  const segment = inferCommercialSegment(text);
  if ((context.purpose === "audit" || context.purpose === "commercial") && segment && context.commercial?.segment !== segment) {
    context = { ...context, commercial: { segment, segmentIdentifiedAt: now }, updatedAt: now };
    changed = true;
  }

  const auditQualified = context.purpose === "audit" && input.allowAuditQualification && explicitlyQualifiesAudit(text);
  if (auditQualified) {
    context = transitionConversationContext(context, "commercial", "audit_qualified", now);
    changed = true;
  }

  return { context, changed, auditQualified };
}

export const SEGMENT_COMMERCIAL_GUIDANCE: Readonly<Record<CommercialSegment, readonly string[]>> = {
  clinic: ["dúvidas de pacientes", "agenda, confirmação, remarcação e cancelamento quando configurados", "handoff humano"],
  salon: ["dúvidas sobre serviços", "horários e agenda quando configurada", "atendimento durante os serviços"],
  restaurant: ["dúvidas e cardápio", "montagem de pedidos configurados", "entrega ou retirada conforme as regras cadastradas"],
  pet: ["dúvidas sobre serviços", "agenda quando configurada", "handoff humano"],
  optical: ["dúvidas frequentes", "agenda quando aplicável", "acompanhamento pelo atendimento e handoff humano"],
  services: ["atendimento e dúvidas", "qualificação inicial", "agenda quando aplicável e configurada"],
};

export function commercialDemoGuidance(segment: CommercialSegment | undefined, canExecuteDemo: boolean): string {
  const focus = segment ? SEGMENT_COMMERCIAL_GUIDANCE[segment].join("; ") : "a necessidade que o prospect acabou de informar";
  return canExecuteDemo
    ? `A capability demo_execution está autorizada. Demonstre somente o fluxo relevante (${focus}) pelas interfaces disponíveis e deixe explícito que é demonstração.`
    : `A capability demo_execution NÃO está autorizada. Você pode explicar ou oferecer continuar uma demonstração sobre ${focus}, mas não execute tools demo nem afirme que testou, ativou ou contratou algo.`;
}
