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

  it("provision repetido já em allowed é no-op sem evento", async () => {
    seedTenant("tenant-a", "target-uid", "allowed");

    await expect(provisionPanelAccess({
      actorUid: "admin-uid",
      targetUid: "target-uid",
      expectedPanelAccess: "allowed",
      requestId: "request-005",
    })).resolves.toMatchObject({ ok: true, outcome: "unchanged" });
    expect(events("tenant-a")).toHaveLength(0);
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

  it("allowed + grant é no-op e não duplica auditoria", async () => {
    seedTenant("tenant-a", "owner-a", "allowed");
    await expect(changePanelAccess(command({
      expectedPanelAccess: "allowed",
      requestId: "request-105",
    }))).resolves.toMatchObject({ ok: true, outcome: "unchanged" });
    expect(events("tenant-a")).toHaveLength(0);
  });

  it("blocked + revoke é no-op e não duplica auditoria", async () => {
    seedTenant("tenant-a", "owner-a", "blocked");
    await expect(changePanelAccess(command({
      action: "revoke",
      expectedPanelAccess: "blocked",
      requestId: "request-106",
    }))).resolves.toMatchObject({ ok: true, outcome: "unchanged" });
    expect(events("tenant-a")).toHaveLength(0);
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

  it("replay do mesmo requestId não repete evento", async () => {
    seedTenant("tenant-a", "owner-a");
    const input = command({ requestId: "request-109" });

    await changePanelAccess(input);
    await expect(changePanelAccess(input)).resolves.toMatchObject({ ok: true, outcome: "replayed" });
    expect(events("tenant-a")).toHaveLength(1);
  });
});
