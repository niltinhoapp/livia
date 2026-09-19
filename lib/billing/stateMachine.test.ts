import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canUseService, nextBillingStatus, type BillingEventType } from "./stateMachine";
import type { BillingStatus, Establishment, EstablishmentBilling } from "@/types";

const NOW = Date.UTC(2026, 8, 15, 12, 0, 0);
const DAY_MS = 24 * 3600000;

function billingOf(over: Partial<EstablishmentBilling> = {}): Pick<Establishment, "billing"> {
  return {
    billing: {
      billingStatus: "trial",
      updatedAt: NOW,
      ...over,
    },
  };
}

describe("canUseService — 1) tenant legado sem billing", () => {
  it("billing ausente → permitido", () => {
    expect(canUseService({ billing: undefined }, NOW)).toBe(true);
  });
});

describe("canUseService — 2) trial", () => {
  it("antes de trialEndsAt → permitido", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW + DAY_MS });
    expect(canUseService(est, NOW)).toBe(true);
  });

  it("exatamente no limite (now === trialEndsAt) → permitido", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW });
    expect(canUseService(est, NOW)).toBe(true);
  });

  it("depois de trialEndsAt (1ms), ainda dentro da tolerância de 24h → permitido (regra definitiva de produto, ver trialWindow.ts)", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW - 1 });
    expect(canUseService(est, NOW)).toBe(true);
  });

  it("1ms antes do fim da tolerância de 24h pós-trialEndsAt → ainda permitido", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW - DAY_MS + 1 });
    expect(canUseService(est, NOW)).toBe(true);
  });

  it("exatamente no fim da tolerância (now === trialEndsAt + 24h) → bloqueado", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW - DAY_MS });
    expect(canUseService(est, NOW)).toBe(false);
  });

  it("bem depois da tolerância → bloqueado", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW - 10 * DAY_MS });
    expect(canUseService(est, NOW)).toBe(false);
  });

  it("trialEndsAt ausente → bloqueado (fail-safe fechado, nunca inventa data)", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: undefined });
    expect(canUseService(est, NOW)).toBe(false);
  });

  it("trialEndsAt inválido (NaN) → bloqueado", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: Number.NaN });
    expect(canUseService(est, NOW)).toBe(false);
  });

  it("trialEndsAt inválido (não-finito) → bloqueado", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: Number.POSITIVE_INFINITY });
    expect(canUseService(est, NOW)).toBe(false);
  });

  it("nunca recalcula trialEndsAt a partir de trialStartAt — mesmo com trialStartAt presente, ausência de trialEndsAt bloqueia", () => {
    const est = billingOf({
      billingStatus: "trial",
      trialStartAt: NOW - 6 * DAY_MS, // dentro dos 7 dias se recalculado — não deve importar
      trialEndsAt: undefined,
    });
    expect(canUseService(est, NOW)).toBe(false);
  });
});

describe("canUseService — 3-6) demais estados", () => {
  it("active → permitido", () => {
    expect(canUseService(billingOf({ billingStatus: "active" }), NOW)).toBe(true);
  });

  it("past_due → permitido (grace period)", () => {
    expect(canUseService(billingOf({ billingStatus: "past_due" }), NOW)).toBe(true);
  });

  it("suspended → bloqueado", () => {
    expect(canUseService(billingOf({ billingStatus: "suspended" }), NOW)).toBe(false);
  });

  it("canceled → bloqueado", () => {
    expect(canUseService(billingOf({ billingStatus: "canceled" }), NOW)).toBe(false);
  });
});

describe("nextBillingStatus — 7) transições válidas", () => {
  const validCases: [BillingStatus, BillingEventType, BillingStatus][] = [
    ["trial", "payment_confirmed", "active"],
    ["trial", "payment_overdue", "past_due"],
    ["trial", "trial_expired", "suspended"],
    ["trial", "cancel", "canceled"],
    ["active", "payment_confirmed", "active"],
    ["active", "payment_overdue", "past_due"],
    ["active", "cancel", "canceled"],
    ["past_due", "payment_confirmed", "active"],
    ["past_due", "payment_overdue", "past_due"],
    ["past_due", "grace_expired", "suspended"],
    ["past_due", "cancel", "canceled"],
    ["suspended", "payment_confirmed", "active"],
    ["suspended", "reactivate", "active"],
    ["suspended", "cancel", "canceled"],
    ["canceled", "reactivate", "active"],
    ["canceled", "cancel", "canceled"],
  ];

  it.each(validCases)("%s + %s → %s", (current, eventType, expected) => {
    const result = nextBillingStatus(current, { type: eventType });
    expect(result).toEqual({ ok: true, next: expected });
  });
});

describe("nextBillingStatus — 8) transições inválidas", () => {
  const invalidCases: [BillingStatus, BillingEventType][] = [
    ["trial", "grace_expired"],
    ["trial", "reactivate"],
    ["active", "trial_expired"],
    ["active", "grace_expired"],
    ["active", "reactivate"],
    ["past_due", "trial_expired"],
    ["past_due", "reactivate"],
    ["suspended", "payment_overdue"],
    ["suspended", "grace_expired"],
    ["suspended", "trial_expired"],
    ["canceled", "payment_confirmed"],
    ["canceled", "payment_overdue"],
    ["canceled", "grace_expired"],
    ["canceled", "trial_expired"],
  ];

  it.each(invalidCases)("%s + %s → inválida", (current, eventType) => {
    const result = nextBillingStatus(current, { type: eventType });
    expect(result).toEqual({ ok: false, reason: "invalid_transition" });
  });
});

describe("nextBillingStatus — 9) payment_confirmed reativa a partir de qualquer estado com assinatura", () => {
  it.each<BillingStatus>(["trial", "past_due", "suspended"])("%s + payment_confirmed → active", (current) => {
    expect(nextBillingStatus(current, { type: "payment_confirmed" })).toEqual({ ok: true, next: "active" });
  });
});

describe("nextBillingStatus — 10) overdue", () => {
  it("active + payment_overdue → past_due", () => {
    expect(nextBillingStatus("active", { type: "payment_overdue" })).toEqual({ ok: true, next: "past_due" });
  });
});

describe("nextBillingStatus — 11) grace expired", () => {
  it("past_due + grace_expired → suspended", () => {
    expect(nextBillingStatus("past_due", { type: "grace_expired" })).toEqual({ ok: true, next: "suspended" });
  });

  it("grace_expired só é válido a partir de past_due", () => {
    for (const current of ["trial", "active", "suspended", "canceled"] as BillingStatus[]) {
      expect(nextBillingStatus(current, { type: "grace_expired" })).toEqual({
        ok: false,
        reason: "invalid_transition",
      });
    }
  });
});

describe("nextBillingStatus — 12) cancelamento", () => {
  it.each<BillingStatus>(["trial", "active", "past_due", "suspended"])("%s + cancel → canceled", (current) => {
    expect(nextBillingStatus(current, { type: "cancel" })).toEqual({ ok: true, next: "canceled" });
  });

  it("canceled + cancel → canceled (idempotente, replay de webhook)", () => {
    expect(nextBillingStatus("canceled", { type: "cancel" })).toEqual({ ok: true, next: "canceled" });
  });
});

describe("nextBillingStatus — 13) reativação é sempre administrativa", () => {
  it("válida a partir de suspended", () => {
    expect(nextBillingStatus("suspended", { type: "reactivate" })).toEqual({ ok: true, next: "active" });
  });

  it("válida a partir de canceled (reprovisionamento deliberado)", () => {
    expect(nextBillingStatus("canceled", { type: "reactivate" })).toEqual({ ok: true, next: "active" });
  });

  it("inválida a partir de trial/active/past_due — nada a 'reativar' ali", () => {
    for (const current of ["trial", "active", "past_due"] as BillingStatus[]) {
      expect(nextBillingStatus(current, { type: "reactivate" })).toEqual({
        ok: false,
        reason: "invalid_transition",
      });
    }
  });

  it("canceled NUNCA reativa por payment_confirmed automático — só por reactivate deliberado", () => {
    expect(nextBillingStatus("canceled", { type: "payment_confirmed" })).toEqual({
      ok: false,
      reason: "invalid_transition",
    });
  });
});

describe("14) determinismo", () => {
  it("nextBillingStatus: mesma entrada produz sempre a mesma saída", () => {
    const results = Array.from({ length: 5 }, () => nextBillingStatus("active", { type: "payment_overdue" }));
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it("canUseService: mesma entrada + mesmo now produz sempre a mesma saída", () => {
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW + DAY_MS });
    const results = Array.from({ length: 5 }, () => canUseService(est, NOW));
    expect(new Set(results).size).toBe(1);
  });

  it("canUseService não depende de nenhum estado global — chamadas intercaladas com now diferentes não vazam entre si", () => {
    // trialEndsAt + 24h (fim real da tolerância) cai exatamente em NOW.
    const est = billingOf({ billingStatus: "trial", trialEndsAt: NOW - DAY_MS });
    expect(canUseService(est, NOW - 1)).toBe(true); // 1ms antes do fim da tolerância
    expect(canUseService(est, NOW + 1)).toBe(false); // 1ms depois -> expirado
    expect(canUseService(est, NOW - 1)).toBe(true); // volta a ser true -> nenhum estado vazou
  });
});

describe("15) nenhum I/O — guarda estrutural do módulo", () => {
  // Remove comentários de linha antes de checar: o arquivo DOCUMENTA, em
  // prosa, por que ele não usa Date.now()/process.env/etc — a checagem tem
  // que olhar só código real, senão a própria explicação vira falso-positivo.
  // Normaliza \r\n -> \n antes de tudo: o regex de comentário usa `.`, que
  // em JS NÃO casa \r — num arquivo com final de linha CRLF (ex.: após um
  // checkout do Git com autocrlf), `//.*$` nunca batia e nada era
  // removido, silenciosamente. Sem isto o teste passava a reprovar por um
  // falso-positivo de line-ending, não por um problema real no código.
  const rawSource = readFileSync(join(__dirname, "stateMachine.ts"), "utf8").replace(/\r\n/g, "\n");
  const code = rawSource
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  const forbidden = [
    "firebase-admin",
    "@/lib/firebase",
    "@/lib/repo",
    "fetch(",
    "process.env",
    "Date.now(",
    "await ",
    "async ",
  ];

  it.each(forbidden)("o código (sem comentários) não referencia '%s'", (needle) => {
    expect(code).not.toContain(needle);
  });

  it("canUseService e nextBillingStatus são funções síncronas (não retornam Promise)", () => {
    const a = nextBillingStatus("active", { type: "payment_confirmed" });
    const b = canUseService(billingOf({ billingStatus: "active" }), NOW);
    expect(a).not.toBeInstanceOf(Promise);
    expect(b).not.toBeInstanceOf(Promise);
  });
});
