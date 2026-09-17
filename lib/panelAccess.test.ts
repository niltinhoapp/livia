import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment } from "@/types";

const getUser = vi.fn();

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser }),
}));
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { db: fake.fakeDb, establishmentRef: fake.establishmentRef, firebaseAdminApp: {} };
});
vi.mock("@/lib/repo", () => ({
  defaultBotConfig: () => ({
    personaName: "Livia",
    tone: "acolhedora e objetiva",
    bookingEnabled: false,
    handoffKeywords: [],
    medicalGuardrail: false,
  }),
  initialTrialBilling: (now: number) => ({
    billingStatus: "trial",
    trialStartAt: now,
    trialEndsAt: now + 7 * 24 * 60 * 60 * 1000,
    updatedAt: now,
  }),
}));

const { changePanelAccess, provisionPanelAccess } = await import("./panelAccess");
const { fakeDb } = await import("@/lib/__testing__/firestoreFake");

function seedTenant(id: string, ownerUid: string, panelAccess?: "allowed" | "blocked"): void {
  const tenant: Establishment = {
    id,
    name: `Tenant ${id}`,
    type: "outro",
    ownerUid,
    status: "active",
    createdAt: 1,
    bot: {
      personaName: "Livia",
      tone: "acolhedora",
      bookingEnabled: false,
      handoffKeywords: [],
      medicalGuardrail: false,
    },
    ...(panelAccess ? { panelAccess } : {}),
  };
  fakeDb.col("establishments").set(id, tenant as unknown as Record<string, unknown>);
}

function tenant(id: string): Establishment | undefined {
  return fakeDb.col("establishments").get(id) as unknown as Establishment | undefined;
}

function events(id: string): Record<string, unknown>[] {
  return [...fakeDb.col(`establishments/${id}/panelAccessEvents`).values()];
}

function requestReceipts(): Record<string, unknown>[] {
  return [...fakeDb.col("_system/panel-access-idempotency-v1/requests").values()];
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeDb.reset();
  vi.setSystemTime(new Date("2026-09-15T15:00:00.000Z"));
  getUser.mockResolvedValue({ uid: "target-uid" });
});

describe("provisionPanelAccess", () => {
  it("falha fechado quando o UID alvo não existe no Firebase", async () => {
    getUser.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "auth/user-not-found" }));

    await expect(provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "missing-uid",
      expectedPanelAccess: "absent",
      requestId: "request-001",
    })).resolves.toEqual({ ok: false, reason: "target_user_not_found" });
    expect(fakeDb.col("establishments").size).toBe(0);
  });

  it("cria tenant determinístico, allowed e sem WhatsApp/whatsappBeta", async () => {
    const result = await provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "absent",
      requestId: "request-002",
    });

    expect(result).toEqual({
      ok: true,
      establishmentId: "target-uid",
      panelAccess: "allowed",
      outcome: "created",
    });
    expect(tenant("target-uid")).toMatchObject({
      id: "target-uid",
      ownerUid: "target-uid",
      panelAccess: "allowed",
      status: "active",
      type: "outro",
    });
    expect(tenant("target-uid")?.whatsapp).toBeUndefined();
    expect(tenant("target-uid")?.whatsappBeta).toBeUndefined();
    // OT-07C: caminho alternativo de criação (fora de upsertEstablishmentConfig)
    // produz o mesmo billing inicial de trial.
    const billing = tenant("target-uid")?.billing;
    expect(billing?.billingStatus).toBe("trial");
    expect(billing?.trialEndsAt! - billing?.trialStartAt!).toBe(7 * 24 * 60 * 60 * 1000);
    expect(events("target-uid")).toEqual([
      expect.objectContaining({
        action: "provision",
        actorUid: "admin-uid",
        before: "absent",
        after: "allowed",
        requestId: "request-002",
        createdAt: Date.now(),
      }),
    ]);
  });

  it("replay do mesmo provisionamento não cria tenant nem auditoria duplicados", async () => {
    const command = {
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "absent" as const,
      requestId: "request-003",
    };

    await provisionPanelAccess(command);
    await expect(provisionPanelAccess(command)).resolves.toMatchObject({ ok: true, outcome: "replayed" });

    expect(fakeDb.col("establishments").size).toBe(1);
    expect(events("target-uid")).toHaveLength(1);
  });

  it("reutiliza tenant existente encontrado por ownerUid e explicita allowed", async () => {
    seedTenant("legacy-tenant", "target-uid");

    await expect(provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "legacy",
      requestId: "request-004",
    })).resolves.toEqual({
      ok: true,
      establishmentId: "legacy-tenant",
      panelAccess: "allowed",
      outcome: "updated",
    });

    expect(fakeDb.col("establishments").size).toBe(1);
    expect(tenant("legacy-tenant")?.panelAccess).toBe("allowed");
  });

  it("provision já em allowed cria recibo no primeiro no-op e reconhece replay", async () => {
    seedTenant("tenant-a", "target-uid", "allowed");

    const command = {
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "allowed" as const,
      requestId: "request-005",
    };

    await expect(provisionPanelAccess(command)).resolves.toMatchObject({ ok: true, outcome: "unchanged" });
    await expect(provisionPanelAccess(command)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    expect(events("tenant-a")).toEqual([
      expect.objectContaining({
        action: "provision",
        actorUid: "admin-uid",
        establishmentId: "tenant-a",
        ownerUid: "target-uid",
        before: "allowed",
        after: "allowed",
        expected: "allowed",
        requestId: "request-005",
        createdAt: Date.now(),
      }),
    ]);
    expect(requestReceipts()).toHaveLength(1);
  });

  it("serializa dois provisions concorrentes para o mesmo UID", async () => {
    const results = await Promise.all([
      provisionPanelAccess({
        actorUid: "admin-uid",
        targetUid: "target-uid",
        expectedPanelAccess: "absent",
        requestId: "request-008",
      }),
      provisionPanelAccess({
        actorUid: "admin-uid",
        targetUid: "target-uid",
        expectedPanelAccess: "absent",
        requestId: "request-009",
      }),
    ]);

    expect(results.filter((result) => result.ok && result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "state_conflict")).toHaveLength(1);
    expect(fakeDb.col("establishments").size).toBe(1);
    expect(events("target-uid")).toHaveLength(1);
  });

  it("reutilização concorrente do mesmo requestId no provision cria um único evento", async () => {
    const command = {
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "absent" as const,
      requestId: "request-010",
    };

    const results = await Promise.all([provisionPanelAccess(command), provisionPanelAccess(command)]);

    expect(results.filter((result) => result.ok && result.outcome === "created")).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.outcome === "replayed")).toHaveLength(1);
    expect(fakeDb.col("establishments").size).toBe(1);
    expect(events("target-uid")).toHaveLength(1);
  });

  it("bloqueia reutilização do requestId de provision para outro UID", async () => {
    seedTenant("tenant-a", "target-uid", "allowed");
    seedTenant("tenant-b", "other-target", "allowed");
    const requestId = "request-011";

    await provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "allowed",
      requestId,
    });
    await expect(provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "other-target",
      expectedPanelAccess: "allowed",
      requestId,
    })).resolves.toEqual({ ok: false, reason: "request_id_conflict" });

    expect(events("tenant-a")).toHaveLength(1);
    expect(events("tenant-b")).toHaveLength(0);
  });

  it("bloqueia mais de um establishment com o mesmo ownerUid", async () => {
    seedTenant("tenant-a", "target-uid");
    seedTenant("tenant-b", "target-uid");

    await expect(provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "legacy",
      requestId: "request-006",
    })).resolves.toEqual({ ok: false, reason: "multiple_establishments" });
    expect(events("tenant-a")).toHaveLength(0);
    expect(events("tenant-b")).toHaveLength(0);
  });

  it("não sobrescreve documento determinístico vinculado a outro ownerUid", async () => {
    seedTenant("target-uid", "different-owner");

    await expect(provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "absent",
      requestId: "request-007",
    })).resolves.toEqual({ ok: false, reason: "owner_uid_mismatch" });
    expect(tenant("target-uid")?.ownerUid).toBe("different-owner");
  });
});

describe("changePanelAccess", () => {
  const command = (overrides: Partial<Parameters<typeof changePanelAccess>[0]> = {}) => ({
    action: "grant" as const,
    actorUid: "admin-uid",
    establishmentId: "tenant-a",
    ownerUid: "owner-a",
    expectedPanelAccess: "legacy" as const,
    requestId: "request-101",
    ...overrides,
  });

  it("legacy + grant vira explicitamente allowed com auditoria atômica", async () => {
    seedTenant("tenant-a", "owner-a");
    await expect(changePanelAccess(command())).resolves.toMatchObject({ ok: true, outcome: "updated" });
    expect(tenant("tenant-a")?.panelAccess).toBe("allowed");
    expect(events("tenant-a")).toEqual([
      expect.objectContaining({ action: "grant", before: "legacy", after: "allowed", actorUid: "admin-uid" }),
    ]);
  });

  it("legacy + revoke vira explicitamente blocked sem apagar dados", async () => {
    seedTenant("tenant-a", "owner-a");
    await changePanelAccess(command({ action: "revoke", requestId: "request-102" }));
    expect(tenant("tenant-a")).toMatchObject({
      name: "Tenant tenant-a",
      ownerUid: "owner-a",
      status: "active",
      panelAccess: "blocked",
    });
  });

  it("blocked + grant vira allowed", async () => {
    seedTenant("tenant-a", "owner-a", "blocked");
    await changePanelAccess(command({ expectedPanelAccess: "blocked", requestId: "request-103" }));
    expect(tenant("tenant-a")?.panelAccess).toBe("allowed");
  });

  it("allowed + revoke vira blocked", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const current = tenant("tenant-a")!;
    fakeDb.col("establishments").set("tenant-a", {
      ...current,
      whatsapp: {
        wabaId: "waba-a",
        phoneNumberId: "phone-a",
        status: "disconnected",
      },
      whatsappBeta: { access: "participant", joinedAt: 10 },
    } as unknown as Record<string, unknown>);

    await changePanelAccess(command({
      action: "revoke",
      expectedPanelAccess: "allowed",
      requestId: "request-104",
    }));
    expect(tenant("tenant-a")?.panelAccess).toBe("blocked");
    expect(tenant("tenant-a")?.whatsapp).toEqual(current.whatsapp ?? {
      wabaId: "waba-a",
      phoneNumberId: "phone-a",
      status: "disconnected",
    });
    expect(tenant("tenant-a")?.whatsappBeta).toEqual({ access: "participant", joinedAt: 10 });
  });

  it("allowed + grant cria recibo no primeiro no-op e replay não duplica auditoria", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const input = command({
      expectedPanelAccess: "allowed",
      requestId: "request-105",
    });

    await expect(changePanelAccess(input)).resolves.toMatchObject({ ok: true, outcome: "unchanged" });
    await expect(changePanelAccess(input)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    expect(tenant("tenant-a")?.panelAccess).toBe("allowed");
    expect(events("tenant-a")).toEqual([
      expect.objectContaining({
        action: "grant",
        actorUid: "admin-uid",
        establishmentId: "tenant-a",
        ownerUid: "owner-a",
        before: "allowed",
        after: "allowed",
        expected: "allowed",
        requestId: "request-105",
        createdAt: Date.now(),
      }),
    ]);
    expect(requestReceipts()).toEqual([
      expect.objectContaining({
        identity: expect.any(String),
      }),
    ]);
  });

  it("blocked + revoke cria recibo no primeiro no-op", async () => {
    seedTenant("tenant-a", "owner-a", "blocked");
    await expect(changePanelAccess(command({
      action: "revoke",
      expectedPanelAccess: "blocked",
      requestId: "request-106",
    }))).resolves.toMatchObject({ ok: true, outcome: "unchanged" });
    expect(events("tenant-a")).toEqual([
      expect.objectContaining({
        action: "revoke",
        before: "blocked",
        after: "blocked",
        expected: "blocked",
        requestId: "request-106",
      }),
    ]);
  });

  it("bloqueia reutilização do requestId de grant no-op em revoke", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const requestId = "request-110";

    await changePanelAccess(command({ expectedPanelAccess: "allowed", requestId }));
    await expect(changePanelAccess(command({
      action: "revoke",
      expectedPanelAccess: "allowed",
      requestId,
    }))).resolves.toEqual({ ok: false, reason: "request_id_conflict" });

    expect(tenant("tenant-a")?.panelAccess).toBe("allowed");
    expect(events("tenant-a")).toEqual([expect.objectContaining({ action: "grant" })]);
    expect(requestReceipts()).toHaveLength(1);
  });

  it("bloqueia reutilização do requestId de no-op com expected state diferente", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const requestId = "request-111";

    await changePanelAccess(command({ expectedPanelAccess: "allowed", requestId }));
    await expect(changePanelAccess(command({
      expectedPanelAccess: "legacy",
      requestId,
    }))).resolves.toEqual({ ok: false, reason: "request_id_conflict" });

    expect(events("tenant-a")).toHaveLength(1);
  });

  it("bloqueia reutilização do requestId de no-op com owner diferente", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const requestId = "request-112";

    await changePanelAccess(command({ expectedPanelAccess: "allowed", requestId }));
    await expect(changePanelAccess(command({
      ownerUid: "owner-b",
      expectedPanelAccess: "allowed",
      requestId,
    }))).resolves.toEqual({ ok: false, reason: "request_id_conflict" });

    expect(tenant("tenant-a")?.ownerUid).toBe("owner-a");
    expect(events("tenant-a")).toHaveLength(1);
  });

  it("bloqueia reutilização do requestId de no-op em outro tenant", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    seedTenant("tenant-b", "owner-b", "allowed");
    const requestId = "request-113";

    await changePanelAccess(command({ expectedPanelAccess: "allowed", requestId }));
    await expect(changePanelAccess(command({
      establishmentId: "tenant-b",
      ownerUid: "owner-b",
      expectedPanelAccess: "allowed",
      requestId,
    }))).resolves.toEqual({ ok: false, reason: "request_id_conflict" });

    expect(events("tenant-a")).toHaveLength(1);
    expect(events("tenant-b")).toHaveLength(0);
  });

  it("bloqueia reutilização do requestId de no-op por outro ator", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const requestId = "request-114";

    await changePanelAccess(command({ expectedPanelAccess: "allowed", requestId }));
    await expect(changePanelAccess(command({
      actorUid: "second-admin",
      expectedPanelAccess: "allowed",
      requestId,
    }))).resolves.toEqual({ ok: false, reason: "request_id_conflict" });

    expect(events("tenant-a")).toHaveLength(1);
  });

  it("falha fechado para tenant inexistente", async () => {
    await expect(changePanelAccess(command())).resolves.toEqual({
      ok: false,
      reason: "establishment_not_found",
    });
  });

  it("falha fechado quando ownerUid do comando diverge do persistido", async () => {
    seedTenant("tenant-a", "real-owner");
    await expect(changePanelAccess(command())).resolves.toEqual({ ok: false, reason: "owner_uid_mismatch" });
    expect(tenant("tenant-a")?.panelAccess).toBeUndefined();
  });

  it("não concede acesso a ownerUid inexistente no Firebase", async () => {
    seedTenant("tenant-a", "owner-a", "blocked");
    getUser.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "auth/user-not-found" }));

    await expect(changePanelAccess(command({ expectedPanelAccess: "blocked" }))).resolves.toEqual({
      ok: false,
      reason: "target_user_not_found",
    });
    expect(tenant("tenant-a")?.panelAccess).toBe("blocked");
    expect(events("tenant-a")).toHaveLength(0);
  });

  it("usa expected state como compare-and-set", async () => {
    seedTenant("tenant-a", "owner-a", "blocked");
    await expect(changePanelAccess(command({ expectedPanelAccess: "legacy" }))).resolves.toEqual({
      ok: false,
      reason: "state_conflict",
    });
    expect(events("tenant-a")).toHaveLength(0);
  });

  it("serializa decisões concorrentes e aceita exatamente uma sobre o mesmo estado", async () => {
    seedTenant("tenant-a", "owner-a");

    const results = await Promise.all([
      changePanelAccess(command({ action: "grant", requestId: "request-107" })),
      changePanelAccess(command({ action: "revoke", requestId: "request-108" })),
    ]);

    expect(results.filter((result) => result.ok && result.outcome === "updated")).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "state_conflict")).toHaveLength(1);
    expect(events("tenant-a")).toHaveLength(1);
  });

  it("serializa dois grants concorrentes com a mesma precondição", async () => {
    seedTenant("tenant-a", "owner-a");

    const results = await Promise.all([
      changePanelAccess(command({ requestId: "request-115" })),
      changePanelAccess(command({ requestId: "request-116" })),
    ]);

    expect(results.filter((result) => result.ok && result.outcome === "updated")).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "state_conflict")).toHaveLength(1);
    expect(events("tenant-a")).toHaveLength(1);
  });

  it("reutilização concorrente do mesmo requestId produz um evento e um replay", async () => {
    seedTenant("tenant-a", "owner-a");
    const input = command({ requestId: "request-117" });

    const results = await Promise.all([changePanelAccess(input), changePanelAccess(input)]);

    expect(results.filter((result) => result.ok && result.outcome === "updated")).toHaveLength(1);
    expect(results.filter((result) => result.ok && result.outcome === "replayed")).toHaveLength(1);
    expect(events("tenant-a")).toHaveLength(1);
    expect(requestReceipts()).toHaveLength(1);
  });

  it("replay do mesmo requestId não repete evento", async () => {
    seedTenant("tenant-a", "owner-a");
    const input = command({ requestId: "request-109" });

    await changePanelAccess(input);
    await expect(changePanelAccess(input)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    expect(events("tenant-a")).toHaveLength(1);
  });

  it("replay de revoke efetivo não repete evento", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    const input = command({
      action: "revoke",
      expectedPanelAccess: "allowed",
      requestId: "request-118",
    });

    await expect(changePanelAccess(input)).resolves.toMatchObject({ ok: true, outcome: "updated" });
    await expect(changePanelAccess(input)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    expect(tenant("tenant-a")?.panelAccess).toBe("blocked");
    expect(events("tenant-a")).toHaveLength(1);
  });
});
