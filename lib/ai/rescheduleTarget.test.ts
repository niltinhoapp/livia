// O pior erro de dado da noite de 06/09/2026.
//
// O cliente estava remarcando a LIMPEZA de 09/09 13:00. O sistema moveu a
// AVALIAÇÃO de 07/09 13:00 — a primeira da fila cronológica — e respondeu
// "seu horário de Avaliação foi remarcado para 09/09 às 16:00". Um cliente
// real perderia o horário sem nunca ser avisado.
//
// Causa: reschedule_appointment operava sempre sobre findNextAppointment. O
// cancelamento já perguntava "qual dos dois?"; a remarcação, não.
//
// Agenda real sobre o Firestore falso — o que importa aqui é qual documento
// foi movido.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, KnowledgeBase, ScheduleConfig } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { createAppointment, defaultScheduleConfig, getAppointment, localToEpoch } from "@/lib/scheduling";
import { runTool, type ToolContext } from "@/lib/ai/tools";

// Domingo 06/09/2026, 21:00 local (-03).
const AGORA = new Date("2026-09-07T00:00:00.000Z").getTime();
const config: ScheduleConfig = defaultScheduleConfig("demo");
const OFFSET = config.utcOffsetMinutes;
const PHONE = "5514996447132";

const est = {
  id: "demo",
  name: "Clínica",
  status: "active",
  bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false },
} as unknown as Establishment;

function ctx(discussedDate: string | null = null): ToolContext {
  return {
    est,
    kb: null as KnowledgeBase | null,
    config,
    contactPhone: PHONE,
    contactName: "niltinho",
    offset: OFFSET,
    customerProfile: null,
    discussedDate,
  };
}

const as = (dateStr: string, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return localToEpoch(dateStr, h! * 60 + m!, OFFSET);
};

async function agendar(serviceName: string, dateStr: string, hhmm: string) {
  return createAppointment("demo", {
    contactPhone: PHONE,
    contactName: "niltinho",
    serviceName,
    startAt: as(dateStr, hhmm),
    durationMin: 30,
    source: "bot",
  });
}

beforeEach(() => {
  fakeDb.reset?.();
  vi.setSystemTime(AGORA);
});

describe("com MAIS DE UM agendamento ativo, a remarcação não escolhe sozinha", () => {
  it("recusa e devolve a lista, em vez de mover o primeiro da fila", async () => {
    const avaliacao = await agendar("Avaliação", "2026-09-07", "13:00");
    const limpeza = await agendar("Limpeza", "2026-09-09", "13:00");

    const r = await runTool("reschedule_appointment", { newStartAt: as("2026-09-09", "16:00") }, ctx());

    expect(r.ok).toBe(false);
    // O erro instrui a perguntar qual — e entrega os dois para a pergunta.
    expect(r.error).toMatch(/mais de um agendamento/i);
    const data = r.data as { appointments: { id: string; serviceName: string }[] };
    expect(data.appointments.map((a) => a.serviceName).sort()).toEqual(["Avaliação", "Limpeza"]);

    // O que mais importa: NADA foi movido.
    expect((await getAppointment("demo", avaliacao.id))!.startAt).toBe(as("2026-09-07", "13:00"));
    expect((await getAppointment("demo", limpeza.id))!.startAt).toBe(as("2026-09-09", "13:00"));
  });

  it("com o id informado, move EXATAMENTE aquele — o caso real", async () => {
    const avaliacao = await agendar("Avaliação", "2026-09-07", "13:00");
    const limpeza = await agendar("Limpeza", "2026-09-09", "13:00");

    const r = await runTool(
      "reschedule_appointment",
      { newStartAt: as("2026-09-09", "16:00"), appointmentId: limpeza.id },
      ctx(),
    );

    expect(r.ok).toBe(true);
    expect((r.data as { serviceName: string }).serviceName).toBe("Limpeza");

    // A Limpeza mudou; a Avaliação ficou onde estava.
    expect((await getAppointment("demo", limpeza.id))!.startAt).toBe(as("2026-09-09", "16:00"));
    expect((await getAppointment("demo", avaliacao.id))!.startAt).toBe(as("2026-09-07", "13:00"));
  });

  it("um id que não é do cliente não move nada", async () => {
    await agendar("Avaliação", "2026-09-07", "13:00");
    await agendar("Limpeza", "2026-09-09", "13:00");

    const r = await runTool(
      "reschedule_appointment",
      { newStartAt: as("2026-09-09", "16:00"), appointmentId: "appt-de-outra-pessoa" },
      ctx(),
    );

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/não está ativo/i);
  });
});

describe("com UM agendamento ativo, nada muda em relação a antes", () => {
  it("remarca direto, sem exigir id", async () => {
    const unico = await agendar("Limpeza", "2026-09-09", "13:00");

    const r = await runTool("reschedule_appointment", { newStartAt: as("2026-09-09", "16:00") }, ctx());

    expect(r.ok).toBe(true);
    expect((await getAppointment("demo", unico.id))!.startAt).toBe(as("2026-09-09", "16:00"));
  });

  it("sem nenhum agendamento ativo, avisa que não há o que remarcar", async () => {
    const r = await runTool("reschedule_appointment", { newStartAt: as("2026-09-09", "16:00") }, ctx());

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nenhum agendamento ativo/i);
  });
});
