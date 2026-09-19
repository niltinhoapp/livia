// Orquestração do dispatcher de Campanhas (CAMPANHAS-06). Decide o QUE fazer
// com um lote pequeno de recipients já reclamados por lib/repo.ts: revalidar
// elegibilidade, chamar a Meta e classificar o resultado. Nenhuma escrita
// transacional mora aqui — isso é responsabilidade de repo.ts. Estratégia
// completa (lease, crash pós-Meta, retry/backoff, rate control) documentada
// em docs/CAMPANHAS.md, seção "Dispatcher".
import { randomUUID } from "node:crypto";
import { sendTemplate } from "@/lib/whatsapp/client";
import { marketingEligibilityOf } from "@/lib/campaigns";
import { campaignsSendEnabled } from "@/lib/campaignConfig";
import { resolveCampaignTemplateParams, templateParameterBindingsAreValid } from "@/lib/campaignTemplates";
import {
  applyCampaignRecipientOutcome,
  claimCampaignRecipients,
  completeCampaignIfDrained,
  getCampaign,
  getCustomerProfile,
  getEstablishment,
  recordCampaignRecipientAttemptStart,
  startDueScheduledCampaign,
} from "@/lib/repo";
import type { Campaign, CampaignRecipient, EstablishmentWhatsapp } from "@/types";

export const CAMPAIGN_DISPATCH_DEFAULT_BATCH_SIZE = 20;
export const CAMPAIGN_DISPATCH_MAX_ATTEMPTS = 5;

// Backoff exponencial só entre TENTATIVAS de um mesmo recipient — não tem
// relação com "mensagens por segundo" da campanha inteira (isso é decidido
// pelo espaçamento entre invocações do endpoint, nunca hardcoded aqui).
function retryBackoffMs(attempts: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempts - 1); // 30s, 60s, 2min, 4min, 8min...
  return Math.min(base, 30 * 60_000); // teto: 30min
}

// Meta sinaliza throttling/rate-limit com estes códigos (lista mínima
// documentada, não exaustiva — revisar conforme erros reais observados em
// Production). HTTP 429 cobre o caso genérico.
const RATE_LIMIT_CODES = new Set([4, 80007, 130429]);
// Erros que a Meta não vai resolver com retry: template/parâmetro inválido,
// destinatário que não pode receber, WABA sem permissão para o template.
const PERMANENT_ERROR_CODES = new Set([131026, 132000, 132001, 132012, 132015, 133010]);

export type SendErrorClassification =
  | { kind: "config"; reason: string }
  | { kind: "rate_limited"; reason: string }
  | { kind: "permanent"; reason: string }
  | { kind: "retryable"; reason: string }
  | { kind: "ambiguous"; reason: string };

// `sendTemplate` (lib/whatsapp/client.ts) só lança um Error com o prefixo
// "WhatsApp sendTemplate falhou: {...}" quando a Graph API DE FATO respondeu
// (res.ok === false) — nesse caso sabemos com certeza que a Meta NÃO
// processou o envio. Qualquer outro erro (fetch() que nunca voltou:
// timeout, rede caiu, processo derrubado no meio) não tem essa forma: não
// há como provar que a Meta não recebeu, então é tratado como AMBÍGUO —
// nunca como retryable cego.
export function classifySendError(error: unknown): SendErrorClassification {
  const message = error instanceof Error ? error.message : String(error);

  if (message.includes("WhatsApp não está conectado") || message.includes("sem accessToken cifrado")) {
    return { kind: "config", reason: sanitizeErrorMessage(message) };
  }

  const match = message.match(/^WhatsApp sendTemplate falhou: (\{.*\})$/);
  if (!match) {
    return { kind: "ambiguous", reason: "sem resposta confirmada da Meta (erro de rede/timeout)" };
  }

  let parsed: { status?: number; code?: number | null } = {};
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { kind: "ambiguous", reason: "resposta da Meta não pôde ser interpretada" };
  }

  const status = parsed.status;
  const code = parsed.code ?? undefined;
  const reason = sanitizeErrorMessage(`meta_error status=${status ?? "?"} code=${code ?? "?"}`);

  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return { kind: "rate_limited", reason };
  }
  if (code !== undefined && PERMANENT_ERROR_CODES.has(code)) {
    return { kind: "permanent", reason };
  }
  return { kind: "retryable", reason };
}

// Nunca deixa passar texto livre da Meta/erro de rede pro Firestore —
// mesma preocupação de lib/whatsapp/client.ts::graphErrorDetail.
function sanitizeErrorMessage(message: string): string {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 300);
}

export interface DispatchCampaignBatchOptions {
  batchSize?: number;
  workerId?: string;
  now?: number;
}

export interface DispatchCampaignBatchResult {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  retryScheduled: number;
  aborted?: "send_disabled" | "campaign_not_running" | "whatsapp_not_connected" | "missing_template" | "campaign_not_found";
}

/**
 * Processa UM lote pequeno de recipients pendentes de UMA campanha. Não
 * itera sozinho até esvaziar a campanha — cada chamada cuida só do lote
 * reclamado; campanhas grandes exigem várias invocações (ver endpoint em
 * app/api/cron/campaigns-dispatch/route.ts). Nunca chama a Meta se a
 * campanha não estiver "running" ou se o WhatsApp do estabelecimento não
 * estiver conectado — aborta o lote inteiro sem reivindicar nada.
 */
export async function dispatchCampaignBatch(
  establishmentId: string,
  campaignId: string,
  options: DispatchCampaignBatchOptions = {},
): Promise<DispatchCampaignBatchResult> {
  const empty: DispatchCampaignBatchResult = { claimed: 0, sent: 0, skipped: 0, failed: 0, retryScheduled: 0 };

  // Defesa na última camada: nenhuma chamada interna ao dispatcher pode
  // contornar o kill switch das rotas HTTP/cron.
  if (!campaignsSendEnabled()) return { ...empty, aborted: "send_disabled" };

  const campaign = await getCampaign(establishmentId, campaignId);
  if (!campaign) return { ...empty, aborted: "campaign_not_found" };
  if (campaign.status === "scheduled") {
    const started = await startDueScheduledCampaign(establishmentId, campaignId, options.now ?? Date.now());
    if (!started || started.status !== "running") return { ...empty, aborted: "campaign_not_running" };
  } else if (campaign.status !== "running") {
    return { ...empty, aborted: "campaign_not_running" };
  }
  if (!campaign.template?.name || !campaign.template.languageCode || !templateParameterBindingsAreValid(campaign.template.components, campaign.template.parameterBindings)) {
    return { ...empty, aborted: "missing_template" };
  }

  const establishment = await getEstablishment(establishmentId);
  const wa = establishment?.whatsapp;
  if (!wa || wa.status !== "connected") {
    return { ...empty, aborted: "whatsapp_not_connected" };
  }

  const workerId = options.workerId ?? randomUUID();
  const now = options.now ?? Date.now();
  const batchSize = options.batchSize ?? CAMPAIGN_DISPATCH_DEFAULT_BATCH_SIZE;

  const claimedRecipients = await claimCampaignRecipients(establishmentId, campaignId, workerId, { batchSize, now });

  const result: DispatchCampaignBatchResult = { ...empty, claimed: claimedRecipients.length };

  for (const recipient of claimedRecipients) {
    const outcome = await processOneRecipient(establishmentId, campaignId, workerId, campaign, wa, recipient, now);
    if (outcome === "sent") result.sent++;
    else if (outcome === "skipped") result.skipped++;
    else if (outcome === "failed") result.failed++;
    else if (outcome === "retry") result.retryScheduled++;

    // Throttling da Meta: interrompe o resto DESTE lote imediatamente em vez
    // de continuar batendo na Graph API — o próximo recipient será tentado
    // numa invocação futura.
    if (outcome === "rate_limited_stop") {
      result.retryScheduled++;
      break;
    }
  }

  await completeCampaignIfDrained(establishmentId, campaignId, now);

  return result;
}

type RecipientOutcomeTag = "sent" | "skipped" | "failed" | "retry" | "rate_limited_stop" | "stale";

async function processOneRecipient(
  establishmentId: string,
  campaignId: string,
  workerId: string,
  campaign: Campaign,
  wa: EstablishmentWhatsapp,
  recipient: CampaignRecipient,
  now: number,
): Promise<RecipientOutcomeTag> {
  // Revalidação OBRIGATÓRIA: o snapshot da audiência não é autorização.
  const profile = await getCustomerProfile(establishmentId, recipient.customerPhone);
  if (!profile) {
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "skipped",
      reason: "customer_not_found_at_send_time",
    });
    return applied === "applied" ? "skipped" : "stale";
  }
  const eligibility = marketingEligibilityOf(profile);
  if (!eligibility.eligible) {
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "skipped",
      reason: eligibility.reason,
    });
    return applied === "applied" ? "skipped" : "stale";
  }

  const attempts = recipient.attempts ?? 0;
  if (attempts >= CAMPAIGN_DISPATCH_MAX_ATTEMPTS) {
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "failed",
      reason: "max_attempts_exceeded",
    });
    return applied === "applied" ? "failed" : "stale";
  }

  // Persistido ANTES da chamada de rede — é o que torna o crash pós-Meta
  // detectável (ver comentário em lib/repo.ts::recordCampaignRecipientAttemptStart).
  const attemptStarted = await recordCampaignRecipientAttemptStart(establishmentId, recipient.id, workerId, now);
  if (!attemptStarted) return "stale";

  if (!campaign.template) {
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "failed",
      reason: "campaign_without_template_snapshot",
    });
    return applied === "applied" ? "failed" : "stale";
  }

  const params = resolveCampaignTemplateParams(campaign.template, profile.name ?? recipient.customerName);
  if (!params) {
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "failed",
      reason: "campaign_template_parameters_invalid",
    });
    return applied === "applied" ? "failed" : "stale";
  }

  try {
    // Só o templateSnapshot já salvo na Campaign — o dispatcher nunca troca
    // por outro template.
    const { waMessageId } = await sendTemplate(
      wa,
      establishmentId,
      recipient.customerPhone,
      campaign.template.name,
      campaign.template.languageCode,
      params,
    );
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "sent",
      metaMessageId: waMessageId,
    });
    return applied === "applied" ? "sent" : "stale";
  } catch (error) {
    const classification = classifySendError(error);
    console.error(`[campaignDispatcher] falha ao enviar ${establishmentId}/${campaignId}/${recipient.id}:`, classification.kind, classification.reason);

    if (classification.kind === "ambiguous") {
      const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
        kind: "failed",
        reason: classification.reason,
        ambiguous: true,
      });
      return applied === "applied" ? "failed" : "stale";
    }
    if (classification.kind === "permanent" || classification.kind === "config") {
      const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
        kind: "failed",
        reason: classification.reason,
      });
      return applied === "applied" ? "failed" : "stale";
    }

    // retryable e rate_limited: mesmo tratamento de reagendamento, mas
    // rate_limited também interrompe o lote (sinalizado ao chamador).
    const nextAttemptAt = now + retryBackoffMs(attempts + 1);
    const applied = await applyCampaignRecipientOutcome(establishmentId, campaignId, recipient.id, workerId, {
      kind: "retry",
      reason: classification.reason,
      nextAttemptAt,
    });
    if (applied !== "applied") return "stale";
    return classification.kind === "rate_limited" ? "rate_limited_stop" : "retry";
  }
}
