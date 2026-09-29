import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb, firebaseAdminApp: {} };
});
const sendTemplate = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.tpl" }));
vi.mock("@/lib/whatsapp/client", () => ({ sendTemplate: (...a: unknown[]) => sendTemplate(...a), normalizePhone: (v: string) => v }));
type Multicast = { tokens: string[]; webpush?: { headers?: Record<string, string> } };
const sendEachForMulticast = vi.fn(async ({ tokens }: Multicast) => ({
  successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true })),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ sendEachForMulticast: (m: Multicast) => sendEachForMulticast(m) }) }));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { deliverHandoffEpisode, HANDOFF_DELIVERY, notifyHandoffActivity, notifyHandoffConfirmed, recoverHandoffNotifications } from "./notifications";
import { HANDOFF_PUSH_REMINDER_INTERVAL_MS, handoffEpisodeId, shouldNotifyHumanHandoff, templateParamsFor } from "./policy";
import type { Conversation, Establishment, HandoffNotificationRecord, HumanHandoffNotificationConfig } from "@/types";

const EST = "est-a";
const CONV = "5511900000001";
const T0 = 1_000_000_000;
const EPISODE = `${CONV}_${T0}`;
const config = (over: Partial<HumanHandoffNotificationConfig> = {}): HumanHandoffNotificationConfig => ({
  push: true, whatsapp: true, responsiblePhone: "5514999990000", templateName: "aviso", templateLang: "pt_BR", templateParamCount: 1, updatedAt: 0, ...over,
});
const est = (over: Partial<Establishment> = {}) => ({
  id: EST, name: "Clínica", ownerUid: "o", status: "active", createdAt: 0, type: "clinica",
  bot: { personaName: "Lívia", tone: "", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
  whatsapp: { wabaId: "w", phoneNumberId: "p", status: "connected", pin: { ciphertext: "", iv: "", authTag: "" } },
  humanHandoffNotifications: config(), ...over,
}) as unknown as Establishment;
const conv = (over: Record<string, unknown> = {}) => ({ id: CONV, contactName: "João", contactPhone: CONV, handoffStartedAt: T0, status: "handoff" as const, ...over });
const device = (id: string, token: string) => fakeDb.col(`establishments/${EST}/pushDevices`).set(id, { id, token, uid: "o", userAgent: null, createdAt: 0, lastSeenAt: 0 });
const episodes = () => fakeDb.col(`establishments/${EST}/handoffNotifications`);
const episode = () => episodes().get(EPISODE) as unknown as HandoffNotificationRecord;
const conversationDoc = () => fakeDb.col(`establishments/${EST}/conversations`).get(CONV) as unknown as Conversation;
const metaError = (status: number, code: number) => new Error(`WhatsApp sendTemplate falhou: ${JSON.stringify({ status, code })}`);

function seedConversation(over: Partial<Conversation> = {}) {
  fakeDb.col(`establishments/${EST}/conversations`).set(CONV, {
    id: CONV, establishmentId: EST, contactPhone: CONV, contactName: "João", status: "handoff", handoffStartedAt: T0, lastMessageAt: 0, createdAt: 0, ...over,
  });
}
// Estado que existe quando a execução caiu logo depois de gravar o episódio.
function seedInterruptedEpisode(over: Partial<HandoffNotificationRecord> = {}) {
  episodes().set(EPISODE, {
    id: EPISODE, conversationId: CONV, handoffStartedAt: T0, createdAt: T0, lastPushAt: null, pushReminders: 0, needsDelivery: true,
    push: { status: "pending", attempts: 0 }, whatsapp: { status: "pending", attempts: 0 }, ...over,
  });
}

beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  sendTemplate.mockImplementation(async () => ({ waMessageId: "wamid.tpl" }));
  sendEachForMulticast.mockImplementation(async ({ tokens }: Multicast) => ({ successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true })) }));
  fakeDb.col("establishments").set(EST, est() as never);
  device("d1", "token-aparelho-1-0000000000000000");
  seedConversation();
});

describe("política", () => {
  it("só atendimento real de estabelecimento cliente, com algum canal ligado", () => {
    expect(shouldNotifyHumanHandoff(est(), { purpose: "operational" })).toBe(true);
    expect(shouldNotifyHumanHandoff(est(), undefined)).toBe(true);
    expect(shouldNotifyHumanHandoff(est(), { purpose: "commercial" })).toBe(false);
    expect(shouldNotifyHumanHandoff(est(), { purpose: "audit" })).toBe(false);
    expect(shouldNotifyHumanHandoff(est({ demoChannel: { enabled: true } }), { purpose: "operational" })).toBe(false);
    expect(shouldNotifyHumanHandoff(est({ humanHandoffNotifications: undefined }), { purpose: "operational" })).toBe(false);
    expect(shouldNotifyHumanHandoff(est({ humanHandoffNotifications: config({ push: false, whatsapp: false }) }), { purpose: "operational" })).toBe(false);
  });

  it("episódio: handoff pendente ou posse humana aberta; conversa devolvida não tem episódio", () => {
    expect(handoffEpisodeId({ id: "c", handoffStartedAt: 5 })).toBe("c_5");
    expect(handoffEpisodeId({ id: "c", humanOwnership: { assumedAt: 7, assumedBy: "o" } })).toBe("c_h7");
    expect(handoffEpisodeId({ id: "c", humanOwnership: { assumedAt: 7, assumedBy: "o", returnedAt: 9, returnedBy: "o" } })).toBeNull();
  });

  it("variáveis do template: nenhuma, cliente, ou cliente + link", () => {
    const c = { id: "551190", contactName: null, contactPhone: "551190" };
    expect(templateParamsFor({ templateParamCount: 0 }, c, "https://x")).toEqual([]);
    expect(templateParamsFor({ templateParamCount: 1 }, c, "https://x")).toEqual(["551190"]);
    expect(templateParamsFor({ templateParamCount: 2 }, c, "https://x/")).toEqual(["551190", "https://x/painel/conversas?conversa=551190"]);
  });
});

describe("aviso de handoff confirmado", () => {
  it("B/E: os dois canais, resultado e wamid registrados; nada fica pendente", async () => {
    const record = await notifyHandoffConfirmed(est(), conv(), T0);
    expect(sendTemplate).toHaveBeenCalledWith(expect.anything(), EST, "5514999990000", "aviso", "pt_BR", ["João"]);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ needsDelivery: false, push: { status: "sent", delivered: 1, attempts: 1 }, whatsapp: { status: "sent", waMessageId: "wamid.tpl", attempts: 1 } });
  });

  it("C: somente push", async () => {
    await notifyHandoffConfirmed(est({ humanHandoffNotifications: config({ whatsapp: false }) }), conv(), T0);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(episode()).toMatchObject({ push: { status: "sent" }, whatsapp: { status: "skipped", reason: "disabled" } });
  });

  it("D: somente WhatsApp", async () => {
    await notifyHandoffConfirmed(est({ humanHandoffNotifications: config({ push: false }) }), conv(), T0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    expect(episode()).toMatchObject({ push: { status: "skipped" }, whatsapp: { status: "sent" } });
  });

  it("F: falha não lança; template com resultado desconhecido vira failed, push transitório reagenda", async () => {
    sendTemplate.mockRejectedValueOnce(new Error("socket hang up 5514999990000"));
    sendEachForMulticast.mockRejectedValueOnce(new Error("down"));
    await expect(notifyHandoffConfirmed(est(), conv(), T0)).resolves.toMatchObject({
      needsDelivery: true,
      whatsapp: { status: "failed", reason: "outcome_unknown" },
      push: { status: "pending", attempts: 1, nextAttemptAt: T0 + HANDOFF_DELIVERY.backoffMs(1) },
    });
    expect(JSON.stringify(episode())).not.toContain("5514999990000");
  });

  it("WhatsApp desconectado ou sem aparelho com push: pulado, sem erro", async () => {
    fakeDb.col(`establishments/${EST}/pushDevices`).clear();
    await notifyHandoffConfirmed(est({ whatsapp: undefined }), conv(), T0);
    expect(episode()).toMatchObject({ needsDelivery: false, push: { status: "skipped", reason: "no_devices" }, whatsapp: { status: "skipped", reason: "whatsapp_not_connected" } });
  });

  it("G/Q: o mesmo episódio nunca avisa duas vezes, nem em chamadas concorrentes", async () => {
    await Promise.all([notifyHandoffConfirmed(est(), conv(), T0), notifyHandoffConfirmed(est(), conv(), T0)]);
    await notifyHandoffConfirmed(est(), conv(), T0 + 5);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it("push agrupável: o mesmo aviso sai com o mesmo Topic (o serviço de push não empilha reenvio)", async () => {
    await notifyHandoffConfirmed(est(), conv(), T0);
    const topic = sendEachForMulticast.mock.calls[0]![0].webpush?.headers?.Topic;
    expect(topic).toMatch(/^[0-9a-f]{32}$/);
  });

  it("subscription expirada é removida; as válidas continuam recebendo", async () => {
    device("d2", "token-aparelho-morto-000000000000");
    sendEachForMulticast.mockImplementationOnce(async ({ tokens }: Multicast) => ({
      successCount: 1, failureCount: 1,
      responses: tokens.map((t) => (t.includes("morto") ? { success: false, error: { code: "messaging/registration-token-not-registered" } } : { success: true })),
    }) as never);
    await notifyHandoffConfirmed(est(), conv(), T0);
    expect(fakeDb.col(`establishments/${EST}/pushDevices`).has("d2")).toBe(false);
    expect(fakeDb.col(`establishments/${EST}/pushDevices`).has("d1")).toBe(true);
    expect(episode().push).toMatchObject({ status: "sent", delivered: 1 });
  });

  it("isolamento: aparelhos de outro estabelecimento nunca recebem", async () => {
    fakeDb.col("establishments/est-b/pushDevices").set("db", { id: "db", token: "token-de-outro-tenant-00000000000", uid: "b", userAgent: null, createdAt: 0, lastSeenAt: 0 });
    await notifyHandoffConfirmed(est(), conv(), T0);
    expect(sendEachForMulticast.mock.calls[0]![0].tokens).toEqual(["token-aparelho-1-0000000000000000"]);
  });
});

describe("recuperação do aviso inicial interrompido", () => {
  it("1: processo caiu depois de gravar o episódio e antes de enviar → a recuperação entrega uma vez", async () => {
    seedInterruptedEpisode();
    await recoverHandoffNotifications(T0 + 60_000);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(episode()).toMatchObject({ needsDelivery: false, push: { status: "sent" }, whatsapp: { status: "sent", waMessageId: "wamid.tpl" } });
    await recoverHandoffNotifications(T0 + 120_000);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it("1b: processo caiu depois de gravar o handoff e antes do episódio → a recuperação cria e entrega", async () => {
    await recoverHandoffNotifications(T0 + 60_000);
    expect(episode()).toMatchObject({ needsDelivery: false, push: { status: "sent" }, whatsapp: { status: "sent" } });
    expect(sendTemplate).toHaveBeenCalledTimes(1);
  });

  it("handoff antigo sem episódio (antes do aviso existir/ser ligado) não gera aviso tardio", async () => {
    await recoverHandoffNotifications(T0 + HANDOFF_DELIVERY.missingEpisodeWindowMs + 1);
    expect(episodes().size).toBe(0);
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("2/3: duas recuperações concorrentes (e a próxima mensagem do cliente) não duplicam nada", async () => {
    seedInterruptedEpisode();
    await Promise.all([
      recoverHandoffNotifications(T0 + 60_000),
      recoverHandoffNotifications(T0 + 60_000),
      deliverHandoffEpisode(est(), EPISODE, T0 + 60_000),
      notifyHandoffActivity(est(), conv(), T0 + 60_000),
    ]);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
  });

  it("execução ainda em andamento (claim recente) não é atropelada", async () => {
    seedInterruptedEpisode({ push: { status: "processing", claimId: "outra", claimedAt: T0, attempts: 1 }, whatsapp: { status: "processing", claimId: "outra", claimedAt: T0, attempts: 1 } });
    await recoverHandoffNotifications(T0 + 30_000);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });

  it("5: queda DURANTE o envio (claim velho): push é reenviado, template NUNCA é reenviado", async () => {
    seedInterruptedEpisode({ push: { status: "processing", claimId: "morta", claimedAt: T0, attempts: 1 }, whatsapp: { status: "processing", claimId: "morta", claimedAt: T0, attempts: 1 } });
    await recoverHandoffNotifications(T0 + HANDOFF_DELIVERY.staleClaimMs + 1);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(episode()).toMatchObject({ needsDelivery: false, whatsapp: { status: "failed", reason: "outcome_unknown" }, push: { status: "sent", attempts: 2 } });
  });

  it("claim perdido: uma execução atrasada não sobrescreve o resultado de quem retomou", async () => {
    let release!: () => void;
    sendTemplate.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ waMessageId: "wamid.atrasado" }); }));
    const slow = notifyHandoffConfirmed(est({ humanHandoffNotifications: config({ push: false }) }), conv(), T0);
    await vi.waitFor(() => expect(sendTemplate).toHaveBeenCalledTimes(1));
    // Recuperação vê o claim velho: template vira failed (outcome_unknown), sem reenvio.
    await recoverHandoffNotifications(T0 + HANDOFF_DELIVERY.staleClaimMs + 1);
    release();
    await slow;
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(episode().whatsapp).toMatchObject({ status: "failed", reason: "outcome_unknown" });
  });

  it("6: falha temporária da Meta (HTTP 500) reagenda com backoff e entrega depois", async () => {
    sendTemplate.mockRejectedValueOnce(metaError(500, 1));
    await notifyHandoffConfirmed(est({ humanHandoffNotifications: config({ push: false }) }), conv(), T0);
    expect(episode().whatsapp).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: T0 + HANDOFF_DELIVERY.backoffMs(1) });
    await recoverHandoffNotifications(T0 + 1_000);
    expect(sendTemplate).toHaveBeenCalledTimes(1); // ainda no backoff
    await recoverHandoffNotifications(T0 + HANDOFF_DELIVERY.backoffMs(1));
    expect(sendTemplate).toHaveBeenCalledTimes(2);
    expect(episode()).toMatchObject({ needsDelivery: false, whatsapp: { status: "sent", attempts: 2 } });
  });

  it("7: falha permanente (template inválido) termina em failed na hora, sem loop", async () => {
    sendTemplate.mockRejectedValue(metaError(400, 132001));
    await notifyHandoffConfirmed(est({ humanHandoffNotifications: config({ push: false }) }), conv(), T0);
    for (let i = 1; i <= 5; i++) await recoverHandoffNotifications(T0 + i * 60 * 60_000);
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(episode()).toMatchObject({ needsDelivery: false, whatsapp: { status: "failed", attempts: 1 } });
  });

  it("7b: falha transitória eterna para depois do limite de tentativas", async () => {
    sendEachForMulticast.mockRejectedValue(new Error("fcm down"));
    await notifyHandoffConfirmed(est({ humanHandoffNotifications: config({ whatsapp: false }) }), conv(), T0);
    for (let i = 1; i <= 20; i++) await recoverHandoffNotifications(T0 + i * 60 * 60_000);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(HANDOFF_DELIVERY.maxAttempts);
    expect(episode()).toMatchObject({ needsDelivery: false, push: { status: "failed", reason: expect.stringContaining("retries_exhausted") } });
  });

  it("responsável já assumiu antes da recuperação: aviso pendente é descartado, nada é enviado", async () => {
    seedInterruptedEpisode();
    seedConversation({ status: "human", humanOwnership: { assumedAt: T0 + 10, assumedBy: "o" } });
    await deliverHandoffEpisode(est(), EPISODE, T0 + 60_000);
    expect(sendTemplate).not.toHaveBeenCalled();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    expect(episode()).toMatchObject({ needsDelivery: false, push: { status: "skipped", reason: "no_longer_pending" }, whatsapp: { status: "skipped", reason: "no_longer_pending" } });
  });

  it("falhas e recuperação nunca mexem na conversa: status, posse e pendência continuam como estavam", async () => {
    sendTemplate.mockRejectedValue(metaError(400, 132001));
    sendEachForMulticast.mockRejectedValue(new Error("down"));
    seedInterruptedEpisode();
    const before = JSON.stringify(conversationDoc());
    for (let i = 1; i <= 8; i++) await recoverHandoffNotifications(T0 + i * 60 * 60_000);
    expect(JSON.stringify(conversationDoc())).toBe(before);
    expect(conversationDoc().status).toBe("handoff");
  });
});

describe("reaviso quando o cliente escreve de novo", () => {
  it("G: só push, respeitando o intervalo; template nunca repete", async () => {
    await notifyHandoffConfirmed(est(), conv(), T0);
    expect(await notifyHandoffActivity(est(), conv(), T0 + 60_000)).toBe("throttled");
    expect(await notifyHandoffActivity(est(), conv({ status: "human" }), T0 + HANDOFF_PUSH_REMINDER_INTERVAL_MS)).toBe("sent");
    expect(await notifyHandoffActivity(est(), conv({ status: "human" }), T0 + HANDOFF_PUSH_REMINDER_INTERVAL_MS + 1)).toBe("throttled");
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(episode().pushReminders).toBe(1);
  });

  it("mensagem nova retoma o aviso inicial interrompido — e ele conta como o push da janela", async () => {
    seedInterruptedEpisode();
    expect(await notifyHandoffActivity(est(), conv(), T0 + 60_000)).toBe("throttled");
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(episode()).toMatchObject({ needsDelivery: false, push: { status: "sent" } });
  });

  it("atendimento assumido direto no painel também gera reaviso por push, sem template", async () => {
    const assumed = conv({ handoffStartedAt: null, status: "human", humanOwnership: { assumedAt: T0, assumedBy: "o" } });
    expect(await notifyHandoffActivity(est(), assumed, T0 + 1)).toBe("sent");
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("push desligado: nenhum reaviso", async () => {
    expect(await notifyHandoffActivity(est({ humanHandoffNotifications: config({ push: false }) }), conv({ handoffStartedAt: null, humanOwnership: { assumedAt: T0, assumedBy: "o" } }), T0)).toBe("skipped");
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
});
