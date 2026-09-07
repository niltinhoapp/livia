// Matriz de datas pedida no escopo da auditoria (Caso 2).
//
// Referência de calendário usada em todos os casos:
//   domingo  06/09/2026  <- "hoje" na maioria dos testes
//   segunda  07/09/2026
//   terça    08/09/2026
//   quarta   09/09/2026
//   quinta   10/09/2026
//   sexta    11/09/2026
//   sábado   12/09/2026
import { describe, expect, it } from "vitest";
import { parseDateSelection } from "@/lib/ai/dateSelection";

const HOJE = "2026-09-06"; // domingo

describe("referências relativas", () => {
  it.each([
    ["hoje", "2026-09-06"],
    ["pode ser hoje", "2026-09-06"],
    ["amanhã", "2026-09-07"],
    ["amanha", "2026-09-07"],
    ["quero amanhã de manhã", "2026-09-07"],
    ["depois de amanhã", "2026-09-08"],
    ["pode ser depois de amanha", "2026-09-08"],
  ])("%s -> %s", (texto, esperado) => {
    expect(parseDateSelection(texto, HOJE)).toBe(esperado);
  });

  it('"depois de amanhã" não é lido como "amanhã"', () => {
    expect(parseDateSelection("depois de amanhã", HOJE)).not.toBe("2026-09-07");
  });
});

describe("nomes de dia da semana", () => {
  it.each([
    ["segunda", "2026-09-07"],
    ["segunda-feira", "2026-09-07"],
    ["segunda feira", "2026-09-07"],
    ["na segunda", "2026-09-07"],
    ["quero segunda", "2026-09-07"],
    ["segunda que vem", "2026-09-07"],
    ["próxima segunda", "2026-09-07"],
    ["terça", "2026-09-08"],
    ["terca", "2026-09-08"],
    ["terça-feira", "2026-09-08"],
    ["na terça", "2026-09-08"],
    ["pode ser terça", "2026-09-08"],
    ["terça que vem", "2026-09-08"],
    ["próxima terça", "2026-09-08"],
    ["quarta", "2026-09-09"],
    ["quinta", "2026-09-10"],
    ["sexta", "2026-09-11"],
    ["sábado", "2026-09-12"],
    ["sabado", "2026-09-12"],
  ])("%s -> %s", (texto, esperado) => {
    expect(parseDateSelection(texto, HOJE)).toBe(esperado);
  });

  // O erro exato de Production: "terça" virando segunda-feira.
  it("terça NUNCA cai em segunda", () => {
    expect(parseDateSelection("terca feira", HOJE)).not.toBe("2026-09-07");
  });

  it("o dia de hoje pelo nome aponta para a semana seguinte, nunca para trás", () => {
    // Hoje é domingo; "domingo" só pode significar o próximo.
    expect(parseDateSelection("domingo", HOJE)).toBe("2026-09-13");
    // E numa segunda-feira, "segunda" é a semana que vem.
    expect(parseDateSelection("segunda", "2026-09-07")).toBe("2026-09-14");
  });
});

describe("datas explícitas", () => {
  it.each([
    ["dia 8", "2026-09-08"],
    ["no dia 15", "2026-09-15"],
    ["dia 30", "2026-09-30"],
    ["08/09", "2026-09-08"],
    ["8/9", "2026-09-08"],
    ["08/09/2026", "2026-09-08"],
    ["08/09/26", "2026-09-08"],
    ["2026-09-08", "2026-09-08"],
  ])("%s -> %s", (texto, esperado) => {
    expect(parseDateSelection(texto, HOJE)).toBe(esperado);
  });

  it("dia do mês que já passou vai para o mês seguinte", () => {
    // Hoje é 06/09: "dia 3" só pode ser outubro.
    expect(parseDateSelection("dia 3", HOJE)).toBe("2026-10-03");
  });

  it("data sem ano que já passou vai para o ano seguinte", () => {
    expect(parseDateSelection("03/09", HOJE)).toBe("2027-09-03");
  });
});

describe("combinações de dia + horário", () => {
  it.each([
    ["terça às 14", "2026-09-08"],
    ["quero terça as 14h", "2026-09-08"],
    ["amanhã às 9:30", "2026-09-07"],
    ["dia 8 as 10", "2026-09-08"],
    ["08/09 às 15:00", "2026-09-08"],
    ["marca para sexta 16h", "2026-09-11"],
  ])("%s -> %s", (texto, esperado) => {
    expect(parseDateSelection(texto, HOJE)).toBe(esperado);
  });
});

describe("mensagens SEM data devolvem null", () => {
  it.each([
    "as 14",
    "14:30",
    "pode ser",
    "sim",
    "ss",
    "qualquer um, escolha você",
    "quero agendar uma limpeza",
    "obrigado",
    "",
  ])("%s", (texto) => {
    expect(parseDateSelection(texto, HOJE)).toBeNull();
  });

  it('"as 14" não vira "dia 14"', () => {
    // Só "dia N" conta como dia do mês; um número solto é horário, e quem
    // decide isso é parseTimeSelection.
    expect(parseDateSelection("as 14", HOJE)).toBeNull();
  });
});
