import { describe, it, expect } from "vitest";
import {
  dayPeriodFromHour,
  dayPeriodFromLocal,
  temporalGreeting,
  detectUserTemporalGreeting,
  greetingGuidanceLine,
  type DayPeriod,
} from "./dayPeriod";

// Instante UTC num horário local desejado quando o offset é 0 — assim
// nowMs + offset(0) lê exatamente a hora `h` em UTC. Determinístico, sem fuso.
const atUtc = (h: number, m = 0) => Date.UTC(2026, 8, 15, h, m, 0);

// Saudação resolvida pelo relógio, como o sistema faz (offset 0 = hora local == UTC).
const greetingAt = (h: number, m = 0) => temporalGreeting(dayPeriodFromLocal(atUtc(h, m), 0));

describe("dayPeriodFromHour — limites únicos e documentados", () => {
  const cases: [number, DayPeriod][] = [
    [0, "madrugada"],
    [5, "madrugada"],
    [6, "manha"],
    [11, "manha"],
    [12, "tarde"],
    [17, "tarde"],
    [18, "noite"],
    [23, "noite"],
  ];
  it.each(cases)("hora %i → %s", (h, period) => {
    expect(dayPeriodFromHour(h)).toBe(period);
  });

  it("normaliza horas fora de 0–23 (defensivo)", () => {
    expect(dayPeriodFromHour(24)).toBe("madrugada");
    expect(dayPeriodFromHour(-1)).toBe("noite");
    expect(dayPeriodFromHour(30)).toBe("manha");
  });
});

describe("FASE 5 — saudação pelo relógio", () => {
  it.each([
    [6, 0],
    [9, 0],
    [11, 59],
  ])("%i:%i → bom dia", (h, m) => {
    expect(greetingAt(h, m)).toBe("bom dia");
  });

  it.each([
    [12, 0],
    [15, 0],
    [17, 59],
  ])("%i:%i → boa tarde", (h, m) => {
    expect(greetingAt(h, m)).toBe("boa tarde");
  });

  it.each([
    [18, 0],
    [23, 30],
    [23, 59],
  ])("%i:%i → boa noite", (h, m) => {
    expect(greetingAt(h, m)).toBe("boa noite");
  });

  it.each([
    [0, 0],
    [0, 30],
    [3, 0],
    [5, 59],
  ])("madrugada %i:%i → nunca 'bom dia'; usa 'boa noite'", (h, m) => {
    expect(dayPeriodFromLocal(atUtc(h, m), 0)).toBe("madrugada");
    expect(greetingAt(h, m)).toBe("boa noite");
    expect(greetingAt(h, m)).not.toBe("bom dia");
  });
});

describe("FASE 5 — timezone: mesmo instante UTC, offsets diferentes → períodos diferentes", () => {
  const instant = Date.UTC(2026, 8, 15, 2, 0, 0); // 02:00 UTC

  it("offset 0 (02:00 local) → madrugada", () => {
    expect(dayPeriodFromLocal(instant, 0)).toBe("madrugada");
  });
  it("offset -180 / America/Sao_Paulo (23:00 local, dia anterior) → noite", () => {
    expect(dayPeriodFromLocal(instant, -180)).toBe("noite");
  });
  it("offset +540 / Tokyo (11:00 local) → manhã", () => {
    expect(dayPeriodFromLocal(instant, 540)).toBe("manha");
  });

  it("o mesmo instante rende saudações diferentes por fuso", () => {
    expect(temporalGreeting(dayPeriodFromLocal(instant, 540))).toBe("bom dia");
    expect(temporalGreeting(dayPeriodFromLocal(instant, -180))).toBe("boa noite");
  });
});

describe("detectUserTemporalGreeting — coerência com o interlocutor", () => {
  it.each([
    ["Boa noite", "boa noite"],
    ["boa noite!", "boa noite"],
    ["Bom dia, tudo bem?", "bom dia"],
    ["boa tarde", "boa tarde"],
    ["BOA NOITE", "boa noite"],
    ["obrigada, boa noite", "boa noite"],
  ])("'%s' → %s", (text, expected) => {
    expect(detectUserTemporalGreeting(text)).toBe(expected);
  });

  it("sem saudação temporal → null", () => {
    expect(detectUserTemporalGreeting("quero marcar um horário")).toBeNull();
    expect(detectUserTemporalGreeting("ok")).toBeNull();
  });
});

describe("FASE 6 — incidente real: ~23:59 local, cliente diz 'Boa noite'", () => {
  const nowMs = atUtc(23, 59); // 23:59 local com offset 0
  const line = greetingGuidanceLine(nowMs, 0, "Boa noite");

  it("a saudação resolvida é 'boa noite', jamais 'bom dia'", () => {
    expect(temporalGreeting(dayPeriodFromLocal(nowMs, 0))).toBe("boa noite");
  });

  it("a orientação do prompt recomenda 'boa noite' e não recomenda 'bom dia'", () => {
    expect(line).toContain('use "boa noite"');
    expect(line).not.toContain('use "bom dia"');
  });

  it("compatível (relógio e cliente = 'boa noite') → usa a saudação, não vai para o neutro", () => {
    expect(line).toContain('use "boa noite"');
    expect(line).not.toContain("NÃO use nenhuma saudação temporal");
  });

  it("virada da meia-noite (00:00 local) também não recomenda 'bom dia'", () => {
    const meiaNoite = greetingGuidanceLine(atUtc(0, 0), 0, "Boa noite");
    expect(meiaNoite).toContain('use "boa noite"');
    expect(meiaNoite).not.toContain('use "bom dia"');
  });
});

describe("Precedência — relógio vs saudação do cliente (sem instruções contraditórias)", () => {
  it("09:00 + 'boa noite' (divergente) → orienta resposta neutra, sem 'bom dia' nem 'boa noite'", () => {
    const line = greetingGuidanceLine(atUtc(9, 0), 0, "boa noite");
    expect(line).toContain("NÃO use nenhuma saudação temporal");
    expect(line).not.toContain('use "bom dia"');
    expect(line).not.toContain('use "boa noite"');
  });

  it("09:00 + 'bom dia' (compatível) → usa 'bom dia'", () => {
    const line = greetingGuidanceLine(atUtc(9, 0), 0, "bom dia");
    expect(line).toContain('use "bom dia"');
    expect(line).not.toContain("NÃO use nenhuma saudação temporal");
  });

  it("18:00 + 'boa tarde' (divergente por 1 min na virada) → neutro, sem contradição", () => {
    const line = greetingGuidanceLine(atUtc(18, 0), 0, "boa tarde");
    expect(line).toContain("NÃO use nenhuma saudação temporal");
    expect(line).not.toContain('use "boa noite"');
  });

  it("sem saudação do cliente → segue o relógio", () => {
    const line = greetingGuidanceLine(atUtc(15, 0), 0, null);
    expect(line).toContain('use "boa tarde"');
    expect(line).not.toContain("NÃO use nenhuma saudação temporal");
  });
});

describe("greetingGuidanceLine — de manhã orienta 'bom dia'", () => {
  it("09:00 local → recomenda 'bom dia'", () => {
    const line = greetingGuidanceLine(atUtc(9, 0), 0, null);
    expect(line).toContain('use "bom dia"');
    expect(line).toContain("manhã");
  });

  it("sem texto do cliente não inclui a cláusula de coerência", () => {
    const line = greetingGuidanceLine(atUtc(9, 0), 0, null);
    expect(line.toLowerCase()).not.toContain("a pessoa cumprimentou");
  });
});
