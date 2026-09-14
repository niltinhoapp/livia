import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, EncryptedToken } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

const {
  WHATSAPP_BETA_LIMIT,
  disconnectWhatsapp,
  finalizeWhatsappConnection,
  getWhatsappBetaEligibility,
} = await import("./repo");
const { fakeDb } = await import("@/lib/__testing__/firestoreFake");

const token: EncryptedToken = { ciphertext: "encrypted", iv: "iv", authTag: "tag" };

function establishment(
  id: string,
  options: { status?: "connecting" | "connected" | "disconnected"; participant?: boolean } = {},
): Establishment {
  const status = options.status ?? "connecting";
  return {
    id,
    name: id,
    type: "outro",
    ownerUid: id,
    status: "active",
    createdAt: 1,
    bot: {
      personaName: "Livia",
      tone: "acolhedora",
      bookingEnabled: false,
      handoffKeywords: [],
      medicalGuardrail: false,
    },
    whatsapp: {
      wabaId: `waba-${id}`,
      phoneNumberId: `phone-${id}`,
      status,
      ...(status === "connecting" ? { attemptId: `attempt-${id}`, leaseExpiresAt: Date.now() + 60_000 } : {}),
      ...(status === "connected" ? { accessToken: token, connectedAt: 100 } : {}),
    },
    ...(options.participant ? { whatsappBeta: { participant: true, joinedAt: 50 } } : {}),
  };
}

function seedTenant(id: string, options?: Parameters<typeof establishment>[1]): void {
  fakeDb.col("establishments").set(id, establishment(id, options) as unknown as Record<string, unknown>);
}

function seedCohort(claimed: number): void {
  fakeDb.col("_system").set("whatsapp-validation-v1", {
    limit: WHATSAPP_BETA_LIMIT,
    claimed,
    initializedAt: 1,
    updatedAt: 1,
  });
}

function tenant(id: string): Establishment {
  return fakeDb.col("establishments").get(id) as unknown as Establishment;
}

function claimed(): number | undefined {
  return fakeDb.col("_system").get("whatsapp-validation-v1")?.claimed as number | undefined;
}

function finalize(id: string) {
  return finalizeWhatsappConnection(id, `attempt-${id}`, {
    wabaId: `waba-${id}`,
    phoneNumberId: `phone-${id}`,
    accessToken: token,
    connectionMode: "coexistence",
  });
}

beforeEach(() => {
  fakeDb.reset();
  vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
});

describe("beta fechado de WhatsApp", () => {
  it("0 participantes: primeira conexão adquire uma vaga somente ao finalizar", async () => {
    seedTenant("tenant-a");

    expect(await getWhatsappBetaEligibility("tenant-a")).toBe("available");
    expect(claimed()).toBeUndefined();

    await expect(finalize("tenant-a")).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });
    expect(claimed()).toBe(1);
    expect(tenant("tenant-a").whatsappBeta?.participant).toBe(true);
    expect(tenant("tenant-a").whatsapp?.status).toBe("connected");
  });

  it("callback repetido do mesmo tenant não incrementa o contador", async () => {
    seedTenant("tenant-a");
    await finalize("tenant-a");

    await expect(finalize("tenant-a")).resolves.toEqual({ ok: false, reason: "stale_attempt" });
    expect(claimed()).toBe(1);
  });

  it("retries concorrentes do mesmo callback continuam idempotentes", async () => {
    seedTenant("tenant-a");

    const results = await Promise.all([finalize("tenant-a"), finalize("tenant-a")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "stale_attempt")).toHaveLength(1);
    expect(claimed()).toBe(1);
    expect(tenant("tenant-a").whatsappBeta?.participant).toBe(true);
  });

  it("9 participantes: a décima empresa é aceita", async () => {
    seedCohort(9);
    seedTenant("tenant-j");

    await expect(finalize("tenant-j")).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });
    expect(claimed()).toBe(10);
    expect(tenant("tenant-j").whatsappBeta?.participant).toBe(true);
  });

  it("10 participantes: a décima primeira empresa é recusada sem ficar conectada", async () => {
    seedCohort(10);
    seedTenant("tenant-k");

    await expect(finalize("tenant-k")).resolves.toEqual({ ok: false, reason: "cohort_full" });
    expect(claimed()).toBe(10);
    expect(tenant("tenant-k").whatsappBeta).toBeUndefined();
    expect(tenant("tenant-k").whatsapp?.status).toBe("connecting");
  });

  it("participante reconecta mesmo quando as 10 vagas estão ocupadas", async () => {
    seedCohort(10);
    seedTenant("tenant-a", { participant: true });

    expect(await getWhatsappBetaEligibility("tenant-a")).toBe("already_participant");
    await expect(finalize("tenant-a")).resolves.toMatchObject({ ok: true, betaOutcome: "already_participant" });
    expect(claimed()).toBe(10);
    expect(tenant("tenant-a").whatsapp?.status).toBe("connected");
  });

  it("criar conta, entrar no painel ou apenas consultar elegibilidade não consome vaga", async () => {
    seedTenant("tenant-a", { status: "disconnected" });

    expect(await getWhatsappBetaEligibility("tenant-a")).toBe("available");
    expect(claimed()).toBeUndefined();
    expect(tenant("tenant-a").whatsappBeta).toBeUndefined();
  });

  it("desconectar não devolve a vaga adquirida", async () => {
    seedCohort(1);
    seedTenant("tenant-a", { status: "connected", participant: true });

    await expect(disconnectWhatsapp("tenant-a")).resolves.toEqual({ outcome: "disconnected" });
    expect(claimed()).toBe(1);
    expect(tenant("tenant-a").whatsappBeta?.participant).toBe(true);
    expect(tenant("tenant-a").whatsapp?.status).toBe("disconnected");
  });

  it("concorrência pela décima vaga aceita somente um tenant", async () => {
    seedCohort(9);
    seedTenant("tenant-j");
    seedTenant("tenant-k");

    const results = await Promise.all([finalize("tenant-j"), finalize("tenant-k")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "cohort_full")).toHaveLength(1);
    expect(claimed()).toBe(10);
    expect([tenant("tenant-j"), tenant("tenant-k")].filter((item) => item.whatsappBeta?.participant)).toHaveLength(1);
  });

  it("bootstrap incorpora conexões existentes antes de aceitar uma nova", async () => {
    seedTenant("legacy", { status: "connected" });
    seedTenant("tenant-a");

    await expect(finalize("tenant-a")).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });

    expect(claimed()).toBe(2);
    expect(tenant("legacy").whatsappBeta?.participant).toBe(true);
    expect(tenant("legacy").whatsappBeta?.joinedAt).toBe(100);
    expect(tenant("tenant-a").whatsappBeta?.participant).toBe(true);
  });
});
