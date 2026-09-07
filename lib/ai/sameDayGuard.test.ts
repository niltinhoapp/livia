// Rede de segurança da auditoria de 06/09/2026: a criação nunca reserva num
// dia diferente do que a conversa está tratando.
//
// A noite inteira teve o mesmo sintoma chegando por caminhos diferentes — a
// listagem oferecia horários de um dia e a criação recebia um instante de
// OUTRO dia. Os desfechos observados em Production:
//
//   "as 16"  (para 07/09) -> "muito próximo"      (era 16:00 de HOJE, já passado)
//   "as 10"  (para 10/09) -> "a clínica está fechada no dia 10/09"
//   "as 15"  (para 09/09) -> "a clínica estará fechada no dia 09/09"
//
// 09/09 e 10/09 são quarta e quinta, abertos. Só domingo (o dia de HOJE
// naquela noite) fecha — e é isso que o backend estava avaliando.
//
// Em vez de perseguir a origem do dia errado, o sistema passa a checar o
// fato. Este teste usa a agenda REAL sobre o Firestore falso.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Establishment, KnowledgeBase, ScheduleConfig } from "@/types";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { defaultScheduleConfig, listAppointments, localToEpoch } from "@/lib/scheduling";
import { runTool, type ToolContext } from "@/lib/ai/tools";

// Domingo 06/09/2026, 21:20 local (-03).
const AGORA = new Date("2026-09-07T00:20:00.000Z").getTime();
const config: ScheduleConfig = defaultScheduleConfig("demo");
const OFFSET = config.utcOffsetMinutes;

const est = {
  id: "demo",
  name: "Clínica",
  status: "active",
  bot: { personaName: "Livia", tone: "", bookingEnabled: true, medicalGuardrail: false },
} as unknown as Establishment;

function ctx(discussedDate: string | null): ToolContext {
  return {
    est,
    kb: null as KnowledgeBase | null,
    config,
    contactPhone: "5514996447132",
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

beforeEach(() => {
  fakeDb.reset?.();
  vi.setSystemTime(AGORA);
});

describe("o dia da reserva tem que ser o dia da conversa", () => {
  it("reserva no dia certo passa normalmente", async () => {
    // 10/09/2026 é quinta-feira: aberto 09:00–18:00.
    const r = await runTool("create_appointment", { serviceName: "Avaliação", startAt: as("2026-09-10", "10:00") }, ctx("2026-09-10"));

    expect(r.ok).toBe(true);
  });

  it("o caso real: conversa em 10/09, instante caindo em 06/09 (hoje, domingo)", async () => {
    const r = await runTool("create_appointment", { serviceName: "Avaliação", startAt: as("2026-09-06", "10:00") }, ctx("2026-09-10"));

    expect(r.ok).toBe(false);
    // A mensagem diz os DOIS dias, para o modelo poder corrigir sozinho.
    expect(r.error).toContain("2026-09-06");
    expect(r.error).toContain("2026-09-10");

    // E, o que mais importa: nada foi gravado no dia errado.
    const dia = Date.UTC(2026, 8, 6) + 3 * 3600000;
    expect(await listAppointments("demo", dia, dia + 24 * 3600000)).toHaveLength(0);
  });

  it("a recusa acontece ANTES de qualquer verdadeiro/falso da agenda", async () => {
    // 12/09 é sábado (fechado). Se a validação de dia não viesse primeiro, o
    // erro seria "não abre nesse dia" e esconderia a causa real.
    const r = await runTool("create_appointment", { serviceName: "Avaliação", startAt: as("2026-09-12", "10:00") }, ctx("2026-09-10"));

    expect(r.ok).toBe(false);
    expect(r.error).toContain("2026-09-10");
  });

  it("remarcação segue a mesma regra", async () => {
    await runTool("create_appointment", { serviceName: "Avaliação", startAt: as("2026-09-10", "10:00") }, ctx("2026-09-10"));

    const r = await runTool("reschedule_appointment", { newStartAt: as("2026-09-06", "11:00") }, ctx("2026-09-10"));

    expect(r.ok).toBe(false);
    expect(r.error).toContain("2026-09-10");
  });

  it("sem dia em discussão, nada é validado — não há o que comparar", async () => {
    const r = await runTool("create_appointment", { serviceName: "Avaliação", startAt: as("2026-09-10", "10:00") }, ctx(null));

    expect(r.ok).toBe(true);
  });
});
