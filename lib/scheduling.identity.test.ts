// Regressão do BUG 2 do teste real de 03/09/2026.
//
// O telefone 5514996447132 já tinha agendamento em nome de "Nilton", mas ao
// perguntar "Qual meu nome?" a Livia respondeu que não sabia. Causa: o nome
// só era lido de CustomerProfile.name, que por sua vez só era escrito a
// partir do nome de perfil do WhatsApp — se o contato não tem nome público,
// o campo nunca era preenchido, e nada olhava para os agendamentos, onde o
// nome já estava.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { createAppointment, findCustomerNameFromAppointments, setStatus } from "@/lib/scheduling";

const EST = "demo";
const OUTRO_EST = "outra-clinica";
const AGORA = new Date("2026-09-03T17:00:00.000Z").getTime();
const AMANHA_09H = new Date("2026-09-04T12:00:00.000Z").getTime();

beforeEach(() => {
  fakeDb.reset?.();
});

describe("identidade do cliente a partir dos agendamentos", () => {
  it("recupera o nome de um agendamento existente do mesmo telefone", async () => {
    await createAppointment(EST, {
      contactPhone: "5514996447132",
      contactName: "Nilton",
      serviceName: "Avaliação",
      startAt: AMANHA_09H,
      durationMin: 60,
      source: "bot",
    });

    expect(await findCustomerNameFromAppointments(EST, "5514996447132", AGORA)).toBe("Nilton");
  });

  it("respeita a normalização de telefone do Bloco 2 (formatos diferentes, mesmo cliente)", async () => {
    // Criado pelo painel com o telefone digitado à mão.
    await createAppointment(EST, {
      contactPhone: "(14) 99644-7132",
      contactName: "Nilton",
      serviceName: "Avaliação",
      startAt: AMANHA_09H,
      durationMin: 60,
      source: "manual",
    });

    // Consultado com o telefone cru que chega do WhatsApp.
    expect(await findCustomerNameFromAppointments(EST, "5514996447132", AGORA)).toBe("Nilton");
  });

  it("devolve null quando o cliente não tem agendamento nenhum", async () => {
    expect(await findCustomerNameFromAppointments(EST, "5511900000000", AGORA)).toBeNull();
  });

  it("devolve null quando o agendamento existe mas está sem nome", async () => {
    await createAppointment(EST, {
      contactPhone: "5514996447132",
      contactName: null,
      serviceName: "Avaliação",
      startAt: AMANHA_09H,
      durationMin: 60,
      source: "bot",
    });

    expect(await findCustomerNameFromAppointments(EST, "5514996447132", AGORA)).toBeNull();
  });

  it("prefere o nome do agendamento mais recente", async () => {
    await createAppointment(EST, {
      contactPhone: "5514996447132",
      contactName: "Nilton",
      serviceName: "Avaliação",
      startAt: AMANHA_09H,
      durationMin: 60,
      source: "bot",
    });
    await createAppointment(EST, {
      contactPhone: "5514996447132",
      contactName: "Nilton Silva",
      serviceName: "Retorno",
      startAt: AMANHA_09H + 7 * 24 * 3600000,
      durationMin: 30,
      source: "bot",
    });

    expect(await findCustomerNameFromAppointments(EST, "5514996447132", AGORA)).toBe("Nilton Silva");
  });

  it("um agendamento cancelado ainda serve como identidade (o nome continua sendo dele)", async () => {
    const appt = await createAppointment(EST, {
      contactPhone: "5514996447132",
      contactName: "Nilton",
      serviceName: "Avaliação",
      startAt: AMANHA_09H,
      durationMin: 60,
      source: "bot",
    });
    await setStatus(EST, appt.id, "cancelled");

    expect(await findCustomerNameFromAppointments(EST, "5514996447132", AGORA)).toBe("Nilton");
  });

  it("nunca atravessa estabelecimentos (isolamento multi-tenant)", async () => {
    await createAppointment(OUTRO_EST, {
      contactPhone: "5514996447132",
      contactName: "Nilton",
      serviceName: "Avaliação",
      startAt: AMANHA_09H,
      durationMin: 60,
      source: "bot",
    });

    expect(await findCustomerNameFromAppointments(EST, "5514996447132", AGORA)).toBeNull();
    expect(await findCustomerNameFromAppointments(OUTRO_EST, "5514996447132", AGORA)).toBe("Nilton");
  });
});
