// Regressão do teste real de 03/09/2026 (BUG 1).
//
// A Livia ofereceu 13:00, 14:00 e 15:00 e, em seguida, o backend recusou os
// três como "já ocupado" — com a agenda comprovadamente vazia nesses
// horários. Causa estrutural: listagem e criação eram DUAS contas
// independentes, cada uma com a duração escolhida livremente pelo modelo, e
// a criação só checava sobreposição (nunca expediente, pausa ou
// antecedência).
//
// Aqui travamos a propriedade que faltava: o que a listagem oferece, a
// criação aceita — e vice-versa.
import { describe, expect, it, vi } from "vitest";

// As funções testadas aqui são puras, mas lib/scheduling.ts importa o
// Firestore no topo do módulo — mesmo fake já usado por
// lib/scheduling.appointmentLookup.test.ts.
vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

import {
  computeSlots,
  slotBookability,
  resolveServiceDuration,
  parseDurationText,
  defaultScheduleConfig,
} from "@/lib/scheduling";
import type { Appointment, KnowledgeService, ScheduleConfig } from "@/types";

const config: ScheduleConfig = defaultScheduleConfig("demo"); // 09-18, almoço 12-13, slot 30, lead 2h
const OFFSET = config.utcOffsetMinutes; // -180

// 04/09/2026 é uma sexta-feira. "Agora" = 03/09 14:00 local, então tudo em
// 04/09 respeita a antecedência mínima de 2h.
const AGORA = new Date("2026-09-03T17:00:00.000Z").getTime();
const localEpoch = (hhmm: string, dia = "2026-09-04") => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.UTC(2026, 8, Number(dia.slice(-2)), h!, m!) - OFFSET * 60000;
};

function appointment(startAt: number, durationMin: number, over: Partial<Appointment> = {}): Appointment {
  return {
    id: `appt-${startAt}`,
    establishmentId: "demo",
    contactPhone: "5514996447132",
    contactName: "Nilton",
    serviceName: "Avaliação",
    startAt,
    durationMin,
    status: "confirmed",
    source: "bot",
    note: null,
    createdAt: 1,
    confirmedAt: null,
    reminderSentAt: null,
    cancelledAt: null,
    ...over,
  };
}

// Estado real da agenda de 04/09 no momento do teste.
const agenda04 = [
  appointment(localEpoch("09:00"), 30, { status: "pending" }),
  appointment(localEpoch("10:00"), 60, { status: "confirmed" }),
];

describe("BUG 1 — o que é oferecido tem que ser criável", () => {
  it("TODO horário oferecido pela listagem é aceito pela mesma regra de criação", () => {
    for (const duracao of [30, 60, 90]) {
      const slots = computeSlots(config, "2026-09-04", duracao, agenda04, AGORA);
      expect(slots.length).toBeGreaterThan(0);

      for (const slot of slots) {
        // Sem nenhuma reserva concorrente no meio: o backend TEM que aceitar.
        const motivo = slotBookability(config, slot.startAt, duracao, agenda04, AGORA);
        expect(motivo, `duração ${duracao}min, slot ${slot.time} foi oferecido mas recusado por "${motivo}"`).toBeNull();
      }
    }
  });

  it("cenário exato do teste real: cliente escolhe 13:00 da lista e o backend cria", () => {
    const duracao = 60; // a duração que a lista real usou
    const slots = computeSlots(config, "2026-09-04", duracao, agenda04, AGORA);

    const escolhido = slots.find((s) => s.time === "13:00");
    expect(escolhido, "13:00 deveria ter sido oferecido").toBeDefined();

    // Nenhuma reserva concorrente aconteceu entre a oferta e a escolha.
    expect(slotBookability(config, escolhido!.startAt, duracao, agenda04, AGORA)).toBeNull();
  });

  it("a lista real de 04/09 é reproduzida com a duração resolvida pelo backend", () => {
    const slots = computeSlots(config, "2026-09-04", 60, agenda04, AGORA).map((s) => s.time);
    expect(slots).toEqual(["11:00", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30", "17:00"]);
  });
});

describe("BUG 1 — a criação não pode aceitar o que a listagem jamais ofereceria", () => {
  it("recusa horário dentro da pausa de almoço", () => {
    expect(slotBookability(config, localEpoch("12:00"), 30, agenda04, AGORA)).toBe("during_break");
  });

  it("recusa horário fora do expediente", () => {
    expect(slotBookability(config, localEpoch("07:00"), 30, agenda04, AGORA)).toBe("outside_hours");
    expect(slotBookability(config, localEpoch("22:00"), 30, agenda04, AGORA)).toBe("outside_hours");
  });

  it("recusa atendimento que não cabe até o fechamento", () => {
    // 17:30 + 60min = 18:30, depois do fechamento às 18:00.
    expect(slotBookability(config, localEpoch("17:30"), 60, agenda04, AGORA)).toBe("outside_hours");
  });

  it("recusa dia em que o estabelecimento não abre (domingo)", () => {
    const domingo = Date.UTC(2026, 8, 6, 10, 0) - OFFSET * 60000; // 06/09/2026 = domingo
    expect(slotBookability(config, domingo, 30, agenda04, AGORA)).toBe("closed_day");
  });

  it("recusa horário sem a antecedência mínima", () => {
    const daquiA30min = AGORA + 30 * 60000; // leadHours = 2
    expect(slotBookability(config, daquiA30min, 30, [], AGORA)).toBe("too_soon");
  });

  it("recusa sobreposição com agendamento ativo", () => {
    expect(slotBookability(config, localEpoch("10:30"), 30, agenda04, AGORA)).toBe("overlap");
  });
});

describe("BUG 1 — status bloqueantes", () => {
  it("cancelado e no_show NÃO bloqueiam o horário", () => {
    const cancelado = [appointment(localEpoch("14:00"), 60, { status: "cancelled" })];
    const faltou = [appointment(localEpoch("14:00"), 60, { status: "no_show" })];
    expect(slotBookability(config, localEpoch("14:00"), 60, cancelado, AGORA)).toBeNull();
    expect(slotBookability(config, localEpoch("14:00"), 60, faltou, AGORA)).toBeNull();
  });

  it("pending e confirmed bloqueiam", () => {
    const pendente = [appointment(localEpoch("14:00"), 60, { status: "pending" })];
    const confirmado = [appointment(localEpoch("14:00"), 60, { status: "confirmed" })];
    expect(slotBookability(config, localEpoch("14:00"), 60, pendente, AGORA)).toBe("overlap");
    expect(slotBookability(config, localEpoch("14:00"), 60, confirmado, AGORA)).toBe("overlap");
  });

  it("remarcação não colide consigo mesma", () => {
    const proprio = appointment(localEpoch("14:00"), 60, { id: "meu", status: "confirmed" });
    expect(slotBookability(config, localEpoch("14:00"), 60, [proprio], AGORA)).toBe("overlap");
    expect(slotBookability(config, localEpoch("14:00"), 60, [proprio], AGORA, "meu")).toBeNull();
  });
});

describe("BUG 1 — duração é autoridade do backend", () => {
  const servicos: KnowledgeService[] = [
    { name: "Avaliação", priceText: null, durationText: "60 min", description: null },
    { name: "Limpeza", priceText: null, durationText: "1h30", description: null },
    { name: "Retorno", priceText: null, durationText: null, description: null },
  ];

  it("usa a duração cadastrada do serviço", () => {
    expect(resolveServiceDuration(config, servicos, "Avaliação")).toBe(60);
    expect(resolveServiceDuration(config, servicos, "avaliacao ")).toBe(60);
  });

  it("cai no padrão do estabelecimento quando o serviço não tem duração", () => {
    expect(resolveServiceDuration(config, servicos, "Retorno")).toBe(config.defaultDurationMin);
  });

  it("cai no padrão quando o serviço não existe no catálogo", () => {
    expect(resolveServiceDuration(config, servicos, "Clareamento")).toBe(config.defaultDurationMin);
    expect(resolveServiceDuration(config, undefined, "Avaliação")).toBe(config.defaultDurationMin);
  });

  it("listagem e criação resolvem a MESMA duração para o mesmo serviço", () => {
    const naListagem = resolveServiceDuration(config, servicos, "Avaliação");
    const naCriacao = resolveServiceDuration(config, servicos, "Avaliação");
    expect(naListagem).toBe(naCriacao);
  });

  it("interpreta as formas de duração que o comerciante escreve", () => {
    expect(parseDurationText("40 min")).toBe(40);
    expect(parseDurationText("1h")).toBe(60);
    expect(parseDurationText("1h30")).toBe(90);
    expect(parseDurationText("1:30")).toBe(90);
    expect(parseDurationText("45")).toBe(45);
    expect(parseDurationText("a combinar")).toBeNull();
    expect(parseDurationText(null)).toBeNull();
    expect(parseDurationText("20 horas")).toBeNull(); // fora de faixa plausível
  });
});
