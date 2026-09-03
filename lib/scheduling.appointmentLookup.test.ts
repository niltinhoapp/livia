// Testes de ORQUESTRAÇÃO da agenda como fonte de verdade.
//
// Não testam normalizePhone() nem um filtro isolado: escrevem um Appointment
// pelo caminho REAL de escrita (createAppointment, usado tanto pela
// ferramenta da IA quanto pelo POST /api/appointments) e provam que ele é
// encontrado pelos caminhos REAIS de leitura (listCustomerAppointments,
// listActiveCustomerAppointments, findNextAppointment) — que é o que decide
// se a Lívia responde a verdade ao cliente.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import {
  createAppointment,
  listCustomerAppointments,
  listActiveCustomerAppointments,
  findNextAppointment,
} from "@/lib/scheduling";
import { normalizePhone } from "@/lib/whatsapp/client";
import type { Appointment, AppointmentStatus } from "@/types";

const EST = "est_odonto";
const OUTRO_EST = "est_pet";

// Número do cliente como a Meta entrega em msg.from.
const PHONE_WEBHOOK = "5514991234567";
// O MESMO número como o dono digita na agenda manual do painel.
const PHONE_DIGITADO = "(14) 99123-4567";

const H = 3600000;
const AMANHA = Date.now() + 24 * H;

beforeEach(() => {
  fakeDb.reset();
  fakeDb.reads = 0;
  delete process.env.LIVIA_LEGACY_PHONE_SCAN;
});

// Escreve um documento legado direto na coleção, sem passar por
// createAppointment — representa o que já está no Firestore hoje.
async function seedLegacy(
  establishmentId: string,
  patch: Partial<Appointment> & { contactPhone: string; startAt: number },
): Promise<Appointment> {
  const id = `legacy_${Math.random().toString(36).slice(2, 10)}`;
  const appt: Appointment = {
    id,
    establishmentId,
    contactName: "Cliente Legado",
    serviceName: "Limpeza",
    durationMin: 30,
    status: "pending",
    source: "manual",
    note: null,
    createdAt: Date.now(),
    confirmedAt: null,
    reminderSentAt: null,
    ...patch,
  };
  fakeDb.col(`establishments/${establishmentId}/appointments`).set(id, appt as unknown as Record<string, unknown>);
  return appt;
}

async function seedMany(
  establishmentId: string,
  contactPhone: string,
  statuses: AppointmentStatus[],
  baseAt = AMANHA,
): Promise<void> {
  for (let i = 0; i < statuses.length; i++) {
    const appt = await createAppointment(establishmentId, {
      contactPhone,
      contactName: "Cliente",
      serviceName: `Serviço ${i}`,
      startAt: baseAt + i * H,
      durationMin: 30,
      source: "bot",
    });
    if (statuses[i] !== "pending") {
      fakeDb
        .col(`establishments/${establishmentId}/appointments`)
        .set(appt.id, { ...appt, status: statuses[i] } as unknown as Record<string, unknown>);
    }
  }
}

describe("CRÍTICO 1 — identidade canônica de telefone", () => {
  it("grava o telefone já canônico, venha do webhook ou digitado no painel", async () => {
    const pelaIA = await createAppointment(EST, {
      contactPhone: PHONE_WEBHOOK,
      contactName: "Ana",
      serviceName: "Avaliação",
      startAt: AMANHA,
      durationMin: 30,
      source: "bot",
    });
    const peloPainel = await createAppointment(EST, {
      contactPhone: PHONE_DIGITADO,
      contactName: "Ana",
      serviceName: "Retorno",
      startAt: AMANHA + 2 * H,
      durationMin: 30,
      source: "manual",
    });

    expect(pelaIA.contactPhone).toBe(normalizePhone(PHONE_WEBHOOK));
    expect(peloPainel.contactPhone).toBe(normalizePhone(PHONE_WEBHOOK));
    expect(pelaIA.contactPhone).toBe(peloPainel.contactPhone);
  });

  it("appointment criado pela IA é encontrado pela leitura real", async () => {
    await createAppointment(EST, {
      contactPhone: PHONE_WEBHOOK,
      contactName: "Ana",
      serviceName: "Avaliação",
      startAt: AMANHA,
      durationMin: 30,
      source: "bot",
    });

    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(1);
    expect(achados[0]!.serviceName).toBe("Avaliação");
  });

  it("appointment criado MANUALMENTE com telefone formatado é encontrado pelo webhook (caso que fazia a Lívia mentir)", async () => {
    await createAppointment(EST, {
      contactPhone: PHONE_DIGITADO, // dono digitou "(14) 99123-4567"
      contactName: "Ana",
      serviceName: "Consulta",
      startAt: AMANHA,
      durationMin: 30,
      source: "manual",
    });

    // Cliente manda "tenho consulta hoje?" — o webhook consulta com msg.from.
    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(1);
    expect(achados[0]!.serviceName).toBe("Consulta");

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo?.serviceName).toBe("Consulta");
  });

  it("documento LEGADO com telefone formatado continua visível (compatibilidade retroativa)", async () => {
    await seedLegacy(EST, {
      contactPhone: "(14) 99123-4567",
      startAt: AMANHA,
      serviceName: "Consulta antiga",
    });

    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(1);
    expect(achados[0]!.serviceName).toBe("Consulta antiga");
  });

  it("documento LEGADO sem DDI continua visível", async () => {
    await seedLegacy(EST, {
      contactPhone: "14991234567", // só dígitos, sem 55
      startAt: AMANHA,
      serviceName: "Retorno antigo",
    });

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo?.serviceName).toBe("Retorno antigo");
  });

  it("legado só é encontrado para o MESMO cliente — outro número não contamina", async () => {
    await seedLegacy(EST, { contactPhone: "(14) 98888-0000", startAt: AMANHA });

    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(0);
  });

  it("cancelamento e remarcação enxergam o agendamento gravado com formato diferente", async () => {
    // findNextAppointment é o que cancel_appointment e reschedule_appointment
    // usam para escolher o alvo (lib/ai/tools.ts).
    await createAppointment(EST, {
      contactPhone: PHONE_DIGITADO,
      contactName: "Ana",
      serviceName: "Limpeza",
      startAt: AMANHA,
      durationMin: 30,
      source: "manual",
    });

    const alvo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(alvo).not.toBeNull();
    expect(alvo!.serviceName).toBe("Limpeza");
  });

  it("confirmação encontra o agendamento pendente criado no painel", async () => {
    await createAppointment(EST, {
      contactPhone: PHONE_DIGITADO,
      contactName: "Ana",
      serviceName: "Avaliação",
      startAt: AMANHA,
      durationMin: 30,
      source: "manual",
    });

    const alvo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(alvo?.status).toBe("pending");
  });

  it("isolamento entre estabelecimentos: agendamento de outro tenant nunca aparece", async () => {
    await createAppointment(OUTRO_EST, {
      contactPhone: PHONE_WEBHOOK,
      contactName: "Ana",
      serviceName: "Banho e tosa",
      startAt: AMANHA,
      durationMin: 30,
      source: "bot",
    });

    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(0);
    expect(await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK))).toBeNull();
  });

  it("isolamento vale também para o fallback de legado", async () => {
    await seedLegacy(OUTRO_EST, { contactPhone: "(14) 99123-4567", startAt: AMANHA });

    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(0);
  });

  it("LIVIA_LEGACY_PHONE_SCAN=off desliga a varredura de legado", async () => {
    process.env.LIVIA_LEGACY_PHONE_SCAN = "off";
    await seedLegacy(EST, { contactPhone: "(14) 99123-4567", startAt: AMANHA });

    const achados = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(achados).toHaveLength(0);
  });
});

describe("CRÍTICO 3 — cancelados não podem esconder um agendamento ativo", () => {
  it("cenário 1: cancelled, cancelled, cancelled, confirmed -> acha o confirmed", async () => {
    await seedMany(EST, PHONE_WEBHOOK, ["cancelled", "cancelled", "cancelled", "confirmed"]);

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo).not.toBeNull();
    expect(proximo!.status).toBe("confirmed");
  });

  it("cenário 2: 10 cancelados + 1 pending -> acha o pending", async () => {
    const statuses: AppointmentStatus[] = [...Array(10).fill("cancelled"), "pending"];
    await seedMany(EST, PHONE_WEBHOOK, statuses);

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo?.status).toBe("pending");

    const ativos = await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(ativos).toHaveLength(1);
    expect(ativos[0]!.status).toBe("pending");
  });

  it("cenário 2b: 30 cancelados (mais que uma página) + 1 pending -> ainda acha", async () => {
    const statuses: AppointmentStatus[] = [...Array(30).fill("cancelled"), "pending"];
    await seedMany(EST, PHONE_WEBHOOK, statuses);

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo?.status).toBe("pending");
  });

  it("cenário 3: só cancelados -> nenhum ativo", async () => {
    await seedMany(EST, PHONE_WEBHOOK, ["cancelled", "cancelled", "no_show"]);

    expect(await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK))).toBeNull();
    expect(await listActiveCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now())).toHaveLength(0);
  });

  it("cenário 4: cancelados de OUTRO cliente não afetam a resposta", async () => {
    await seedMany(EST, "5514988880000", ["cancelled", "cancelled", "cancelled"]);
    await seedMany(EST, PHONE_WEBHOOK, ["pending"]);

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo?.status).toBe("pending");
    expect(proximo!.contactPhone).toBe(normalizePhone(PHONE_WEBHOOK));
  });

  it("cenário 5: agendamento passado + futuro válido -> devolve o futuro", async () => {
    const ONTEM = Date.now() - 24 * H;
    await createAppointment(EST, {
      contactPhone: PHONE_WEBHOOK,
      contactName: "Ana",
      serviceName: "Passado",
      startAt: ONTEM,
      durationMin: 30,
      source: "bot",
    });
    await createAppointment(EST, {
      contactPhone: PHONE_WEBHOOK,
      contactName: "Ana",
      serviceName: "Futuro",
      startAt: AMANHA,
      durationMin: 30,
      source: "bot",
    });

    const proximo = await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK));
    expect(proximo?.serviceName).toBe("Futuro");
  });

  it("listCustomerAppointments segue devolvendo todos os status (contrato inalterado)", async () => {
    await seedMany(EST, PHONE_WEBHOOK, ["cancelled", "pending"]);

    const todos = await listCustomerAppointments(EST, normalizePhone(PHONE_WEBHOOK), Date.now());
    expect(todos).toHaveLength(2);
  });

  it("o custo continua limitado: paginação não vira varredura da coleção", async () => {
    await seedMany(EST, PHONE_WEBHOOK, Array(200).fill("cancelled") as AppointmentStatus[]);
    fakeDb.reads = 0;

    expect(await findNextAppointment(EST, normalizePhone(PHONE_WEBHOOK))).toBeNull();
    // 4 páginas de 25 na query canônica + no máximo 300 no fallback de legado.
    expect(fakeDb.reads).toBeLessThanOrEqual(100 + 300);
  });
});
