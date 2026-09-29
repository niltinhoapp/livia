import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb, firebaseAdminApp: {} };
});
const sendTemplate = vi.fn(async (..._a: unknown[]) => ({ waMessageId: "wamid.tpl" }));
vi.mock("@/lib/whatsapp/client", () => ({ sendTemplate: (...a: unknown[]) => sendTemplate(...a) }));
type Multicast = { tokens: string[] };
const sendEachForMulticast = vi.fn(async ({ tokens }: Multicast) => ({
  successCount: tokens.length, failureCount: 0, responses: tokens.map(() => ({ success: true })),
}));
vi.mock("firebase-admin/messaging", () => ({ getMessaging: () => ({ sendEachForMulticast: (m: Multicast) => sendEachForMulticast(m) }) }));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { notifyHandoffActivity, notifyHandoffConfirmed } from "./notifications";
import { HANDOFF_PUSH_REMINDER_INTERVAL_MS, handoffEpisodeId, shouldNotifyHumanHandoff, templateParamsFor } from "./policy";
import type { Establishment, HandoffNotificationRecord, HumanHandoffNotificationConfig } from "@/types";

const EST = "est-a";
const T0 = 1_000_000;
const config = (over: Partial<HumanHandoffNotificationConfig> = {}): HumanHandoffNotificationConfig => ({
  push: true, whatsapp: true, responsiblePhone: "5514999990000", templateName: "aviso", templateLang: "pt_BR", templateParamCount: 1, updatedAt: 0, ...over,
});
const est = (over: Partial<Establishment> = {}) => ({
  id: EST, name: "Clínica", ownerUid: "o", status: "active", createdAt: 0, type: "clinica",
  bot: { personaName: "Lívia", tone: "", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false },
  whatsapp: { wabaId: "w", phoneNumberId: "p", status: "connected", pin: { ciphertext: "", iv: "", authTag: "" } },
  humanHandoffNotifications: config(), ...over,
}) as unknown as Establishment;
const conv = (over: Record<string, unknown> = {}) => ({ id: "5511900000001", contactName: "João", contactPhone: "5511900000001", handoffStartedAt: T0, status: "handoff" as const, ...over });
const device = (id: string, token: string) => fakeDb.col(`establishments/${EST}/pushDevices`).set(id, { id, token, uid: "o", userAgent: null, createdAt: 0, lastSeenAt: 0 });
const episode = () => [...fakeDb.col(`establishments/${EST}/handoffNotifications`).values()][0] as unknown as HandoffNotificationRecord;

beforeEach(() => {
  fakeDb.reset();
  vi.clearAllMocks();
  device("d1", "token-aparelho-1-0000000000000000");
});
afterEach(() => vi.useRealTimers());

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
  it("B/E: os dois canais, resultado e wamid registrados", async () => {
    const record = await notifyHandoffConfirmed(est(), conv(), T0);
    expect(sendTemplate).toHaveBeenCalledWith(expect.anything(), EST, "5514999990000", "aviso", "pt_BR", ["João"]);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
    expect(record).toMatchObject({ push: { status: "sent", delivered: 1 }, whatsapp: { status: "sent", waMessageId: "wamid.tpl" } });
    expect(episode()).toMatchObject({ push: { status: "sent" }, whatsapp: { status: "sent" } });
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

  it("F: falha da Meta e do FCM não lança — só registra", async () => {
    sendTemplate.mockRejectedValueOnce(new Error("WhatsApp sendTemplate falhou: 5514999990000"));
    sendEachForMulticast.mockRejectedValueOnce(new Error("down"));
    await expect(notifyHandoffConfirmed(est(), conv(), T0)).resolves.toMatchObject({ push: { status: "failed" }, whatsapp: { status: "failed" } });
    expect(JSON.stringify(episode())).not.toContain("5514999990000");
  });

  it("WhatsApp desconectado ou sem aparelho com push: pulado, sem erro", async () => {
    fakeDb.col(`establishments/${EST}/pushDevices`).clear();
    await notifyHandoffConfirmed(est({ whatsapp: undefined }), conv(), T0);
    expect(episode()).toMatchObject({ push: { status: "skipped", reason: "no_devices" }, whatsapp: { status: "skipped", reason: "whatsapp_not_connected" } });
  });

  it("G/Q: o mesmo episódio nunca avisa duas vezes, nem em chamadas concorrentes", async () => {
    const results = await Promise.all([notifyHandoffConfirmed(est(), conv(), T0), notifyHandoffConfirmed(est(), conv(), T0)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await notifyHandoffConfirmed(est(), conv(), T0 + 5)).toBeNull();
    expect(sendTemplate).toHaveBeenCalledTimes(1);
    expect(sendEachForMulticast).toHaveBeenCalledTimes(1);
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

  it("atendimento assumido direto no painel também gera reaviso por push, sem template", async () => {
    const assumed = conv({ handoffStartedAt: null, status: "human", humanOwnership: { assumedAt: T0, assumedBy: "o" } });
    expect(await notifyHandoffActivity(est(), assumed, T0 + 1)).toBe("sent");
    expect(sendTemplate).not.toHaveBeenCalled();
  });

  it("push desligado: nenhum reaviso", async () => {
    expect(await notifyHandoffActivity(est({ humanHandoffNotifications: config({ push: false }) }), conv(), T0)).toBe("skipped");
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
});
