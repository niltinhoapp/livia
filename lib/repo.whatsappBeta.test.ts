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
  options: {
    status?: "connecting" | "connected" | "disconnected";
    access?: "participant" | "grandfathered";
  } = {},
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
    ...(options.access ? { whatsappBeta: { access: options.access, joinedAt: 50 } } : {}),
  };
}

function seedTenant(id: string, options?: Parameters<typeof establishment>[1]): void {
  fakeDb.col("establishments").set(id, establishment(id, options) as unknown as Record<string, unknown>);
}

function seedCohort(claimed: number): void {
  fakeDb.col("_system").set("whatsapp-validation-v1", {
    limit: WHATSAPP_BETA_LIMIT,
    claimed,
    activatedAt: 1,
    updatedAt: 1,
  });
}

function tenant(id: string): Establishment {
  return fakeDb.col("establishments").get(id) as unknown as Establishment;
}

function claimed(): number | undefined {
  return fakeDb.col("_system").get("whatsapp-validation-v1")?.claimed as number | undefined;
}

function prepareAttempt(id: string): void {
  const current = tenant(id);
  fakeDb.col("establishments").set(id, {
    ...current,
    whatsapp: {
      ...current.whatsapp,
      status: "connecting",
      attemptId: `attempt-${id}`,
      leaseExpiresAt: Date.now() + 60_000,
    },
  } as unknown as Record<string, unknown>);
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
    expect(claimed()).toBe(0);

    await expect(finalize("tenant-a")).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });
    expect(claimed()).toBe(1);
    expect(tenant("tenant-a").whatsappBeta?.access).toBe("participant");
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
    expect(tenant("tenant-a").whatsappBeta?.access).toBe("participant");
  });

  it("9 participantes: a décima empresa é aceita", async () => {
    seedCohort(9);
    seedTenant("tenant-j");

    await expect(finalize("tenant-j")).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });
    expect(claimed()).toBe(10);
    expect(tenant("tenant-j").whatsappBeta?.access).toBe("participant");
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
    seedTenant("tenant-a", { access: "participant" });

    expect(await getWhatsappBetaEligibility("tenant-a")).toBe("already_participant");
    await expect(finalize("tenant-a")).resolves.toMatchObject({ ok: true, betaOutcome: "already_participant" });
    expect(claimed()).toBe(10);
    expect(tenant("tenant-a").whatsapp?.status).toBe("connected");
  });

  it("criar conta, entrar no painel ou apenas consultar elegibilidade não consome vaga", async () => {
    seedTenant("tenant-a", { status: "disconnected" });

    expect(await getWhatsappBetaEligibility("tenant-a")).toBe("available");
    expect(claimed()).toBe(0);
    expect(tenant("tenant-a").whatsappBeta).toBeUndefined();
  });

  it("desconectar não devolve a vaga adquirida", async () => {
    seedCohort(1);
    seedTenant("tenant-a", { status: "connected", access: "participant" });

    await expect(disconnectWhatsapp("tenant-a")).resolves.toEqual({ outcome: "disconnected" });
    expect(claimed()).toBe(1);
    expect(tenant("tenant-a").whatsappBeta?.access).toBe("participant");
    expect(tenant("tenant-a").whatsapp?.status).toBe("disconnected");
  });

  it("desconexão direta preserva acesso de conexão legada ainda não classificada", async () => {
    seedTenant("legacy", { status: "connected" });

    await disconnectWhatsapp("legacy");

    expect(tenant("legacy").whatsappBeta?.access).toBe("grandfathered");
    expect(await getWhatsappBetaEligibility("legacy")).toBe("grandfathered");
    expect(claimed()).toBe(0);
  });

  it("concorrência pela décima vaga aceita somente um tenant", async () => {
    seedCohort(9);
    seedTenant("tenant-j");
    seedTenant("tenant-k");

    const results = await Promise.all([finalize("tenant-j"), finalize("tenant-k")]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.reason === "cohort_full")).toHaveLength(1);
    expect(claimed()).toBe(10);
    expect(
      [tenant("tenant-j"), tenant("tenant-k")].filter((item) => item.whatsappBeta?.access === "participant"),
    ).toHaveLength(1);
  });

  it("tenant pré-existente conectado vira grandfathered e o cohort inicia em zero", async () => {
    seedTenant("legacy", { status: "connected" });
    seedTenant("tenant-a");

    expect(await getWhatsappBetaEligibility("tenant-a")).toBe("available");
    expect(claimed()).toBe(0);
    expect(tenant("legacy").whatsappBeta?.access).toBe("grandfathered");
    expect(tenant("legacy").whatsappBeta?.joinedAt).toBe(100);
  });

  it("conexão pré-existente não consome vaga quando a primeira empresa nova conecta", async () => {
    seedTenant("legacy", { status: "connected" });
    seedTenant("tenant-a");

    await getWhatsappBetaEligibility("tenant-a");
    await expect(finalize("tenant-a")).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });

    expect(claimed()).toBe(1);
    expect(tenant("legacy").whatsappBeta?.access).toBe("grandfathered");
    expect(tenant("tenant-a").whatsappBeta?.access).toBe("participant");
  });

  it("tenant pré-existente reconecta quando as 10 novas vagas estão ocupadas", async () => {
    seedTenant("legacy", { status: "connected" });

    expect(await getWhatsappBetaEligibility("legacy")).toBe("grandfathered");
    await disconnectWhatsapp("legacy");
    seedCohort(10);
    prepareAttempt("legacy");

    await expect(finalize("legacy")).resolves.toEqual({ ok: true, betaOutcome: "grandfathered" });
    expect(claimed()).toBe(10);
    expect(tenant("legacy").whatsapp?.status).toBe("connected");
  });

  it("mantém disponíveis exatamente 10 vagas para empresas novas", async () => {
    seedTenant("legacy", { status: "connected" });
    await getWhatsappBetaEligibility("legacy");

    for (let index = 1; index <= WHATSAPP_BETA_LIMIT; index += 1) {
      const id = `new-${index}`;
      seedTenant(id);
      await expect(finalize(id)).resolves.toMatchObject({ ok: true, betaOutcome: "claimed" });
    }

    expect(claimed()).toBe(10);
    expect(tenant("legacy").whatsappBeta?.access).toBe("grandfathered");
    expect(
      [...fakeDb.col("establishments").values()].filter(
        (item) => (item.whatsappBeta as { access?: string } | undefined)?.access === "participant",
      ),
    ).toHaveLength(10);

    seedTenant("new-11");
    await expect(finalize("new-11")).resolves.toEqual({ ok: false, reason: "cohort_full" });
    expect(claimed()).toBe(10);
  });
});
