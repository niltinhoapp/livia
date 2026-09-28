// F0.4 — matriz explícita de entitlement de serviço.
//
// O risco desta frente não é "deixar de bloquear quem não paga": é BLOQUEAR
// QUEM PAGA. Estes testes fixam, caso a caso, quem atende e quem bloqueia —
// com atenção especial aos dois estados que `canUseService` trata de forma
// deliberadamente diferente (fail-closed lá, fail-open aqui) e ao tenant
// legado sem `billing`.
import { afterEach, describe, expect, it } from "vitest";
import type { Establishment } from "@/types";
import { TRIAL_GRACE_WINDOW_MS, TRIAL_PAYMENT_WINDOW_MS } from "./trialWindow";
import {
  billingEnforcementEnabled,
  resolveServiceEntitlement,
  serviceBlockedByBilling,
} from "./serviceEntitlement";

const NOW = 1_800_000_000_000;

function est(billing?: Establishment["billing"]): Pick<Establishment, "billing"> {
  return billing === undefined ? {} : { billing };
}

const trial = (trialEndsAt: unknown): Establishment["billing"] =>
  ({ billingStatus: "trial", trialStartAt: NOW, trialEndsAt, updatedAt: NOW } as unknown as Establishment["billing"]);

afterEach(() => {
  delete process.env.BILLING_ENFORCEMENT_ENABLED;
});

describe("matriz de entitlement — quem ATENDE", () => {
  it("billing AUSENTE (tenant legado/grandfathered) atende", () => {
    const r = resolveServiceEntitlement(est(undefined), NOW);
    expect(r).toEqual({ allowed: true, reason: "no_billing_record" });
  });

  it("trial antes da janela de pagamento atende", () => {
    const r = resolveServiceEntitlement(est(trial(NOW + 5 * 24 * 3600000)), NOW);
    expect(r).toEqual({ allowed: true, reason: "trial_active" });
  });

  it("trial no último dia (janela de pagamento aberta) atende", () => {
    const trialEndsAt = NOW + TRIAL_PAYMENT_WINDOW_MS - 1;
    expect(resolveServiceEntitlement(est(trial(trialEndsAt)), NOW).allowed).toBe(true);
  });

  it("trial no instante exato de trialEndsAt AINDA atende (início da tolerância)", () => {
    expect(resolveServiceEntitlement(est(trial(NOW)), NOW)).toEqual({ allowed: true, reason: "trial_active" });
  });

  it("trial dentro da tolerância de 24h atende", () => {
    const trialEndsAt = NOW - (TRIAL_GRACE_WINDOW_MS - 1);
    expect(resolveServiceEntitlement(est(trial(trialEndsAt)), NOW).allowed).toBe(true);
  });

  it("active atende", () => {
    const r = resolveServiceEntitlement(est({ billingStatus: "active", updatedAt: NOW }), NOW);
    expect(r).toEqual({ allowed: true, reason: "active" });
  });

  it("past_due atende — carência deliberada enquanto a cobrança se resolve", () => {
    const r = resolveServiceEntitlement(est({ billingStatus: "past_due", updatedAt: NOW }), NOW);
    expect(r).toEqual({ allowed: true, reason: "past_due" });
  });
});

describe("matriz de entitlement — quem BLOQUEIA", () => {
  it("trial expirado (tolerância esgotada) bloqueia", () => {
    const trialEndsAt = NOW - TRIAL_GRACE_WINDOW_MS;
    expect(resolveServiceEntitlement(est(trial(trialEndsAt)), NOW)).toEqual({
      allowed: false,
      reason: "trial_expired",
    });
  });

  it("suspended bloqueia", () => {
    expect(resolveServiceEntitlement(est({ billingStatus: "suspended", updatedAt: NOW }), NOW)).toEqual({
      allowed: false,
      reason: "suspended",
    });
  });

  it("canceled bloqueia", () => {
    expect(resolveServiceEntitlement(est({ billingStatus: "canceled", updatedAt: NOW }), NOW)).toEqual({
      allowed: false,
      reason: "canceled",
    });
  });
});

describe("estado não-provável NUNCA corta atendimento", () => {
  // Esta é a diferença deliberada em relação a canUseService, que falha
  // FECHADO nestes mesmos casos porque decide acesso ao PAINEL.
  it("trial sem trialEndsAt atende (canUseService bloquearia)", () => {
    expect(resolveServiceEntitlement(est(trial(undefined)), NOW)).toEqual({
      allowed: true,
      reason: "unprovable_billing_state",
    });
  });

  it("trial com trialEndsAt NaN atende", () => {
    expect(resolveServiceEntitlement(est(trial(Number.NaN)), NOW).allowed).toBe(true);
  });

  it("trial com trialEndsAt Infinity atende", () => {
    expect(resolveServiceEntitlement(est(trial(Number.POSITIVE_INFINITY)), NOW).allowed).toBe(true);
  });

  it("trial com trialEndsAt em string atende", () => {
    expect(resolveServiceEntitlement(est(trial("2026-01-01")), NOW).allowed).toBe(true);
  });

  it("billingStatus fora da união conhecida atende (canUseService devolveria undefined)", () => {
    const corrompido = { billingStatus: "migrando", updatedAt: NOW } as unknown as Establishment["billing"];
    expect(resolveServiceEntitlement(est(corrompido), NOW)).toEqual({
      allowed: true,
      reason: "unprovable_billing_state",
    });
  });

  it("nunca inventa um limite a partir de trialStartAt", () => {
    // trialStartAt muito antigo + trialEndsAt ausente continua atendendo.
    const antigo = { billingStatus: "trial", trialStartAt: NOW - 365 * 24 * 3600000, updatedAt: NOW } as unknown as Establishment["billing"];
    expect(resolveServiceEntitlement(est(antigo), NOW).allowed).toBe(true);
  });
});

describe("kill switch de enforcement", () => {
  it("habilitado por default", () => {
    expect(billingEnforcementEnabled()).toBe(true);
  });

  it('"false" explícito desliga', () => {
    process.env.BILLING_ENFORCEMENT_ENABLED = "false";
    expect(billingEnforcementEnabled()).toBe(false);
  });

  it("qualquer outro valor mantém habilitado", () => {
    process.env.BILLING_ENFORCEMENT_ENABLED = "true";
    expect(billingEnforcementEnabled()).toBe(true);
    process.env.BILLING_ENFORCEMENT_ENABLED = "";
    expect(billingEnforcementEnabled()).toBe(true);
  });

  it("com enforcement desligado, suspended NÃO é bloqueado mas o motivo continua observável", () => {
    process.env.BILLING_ENFORCEMENT_ENABLED = "false";
    expect(serviceBlockedByBilling(est({ billingStatus: "suspended", updatedAt: NOW }), NOW)).toEqual({
      blocked: false,
      reason: "suspended",
    });
  });

  it("com enforcement ligado, suspended é bloqueado", () => {
    expect(serviceBlockedByBilling(est({ billingStatus: "suspended", updatedAt: NOW }), NOW)).toEqual({
      blocked: true,
      reason: "suspended",
    });
  });

  it("tenant legado nunca é bloqueado, com ou sem enforcement", () => {
    expect(serviceBlockedByBilling(est(undefined), NOW).blocked).toBe(false);
    process.env.BILLING_ENFORCEMENT_ENABLED = "false";
    expect(serviceBlockedByBilling(est(undefined), NOW).blocked).toBe(false);
  });
});

describe("fronteira de tempo compartilhada com trialWindow", () => {
  it("o limite de suspensão é exatamente trialEndsAt + TRIAL_GRACE_WINDOW_MS", () => {
    const trialEndsAt = NOW;
    const umInstanteAntes = trialEndsAt + TRIAL_GRACE_WINDOW_MS - 1;
    const noLimite = trialEndsAt + TRIAL_GRACE_WINDOW_MS;
    expect(resolveServiceEntitlement(est(trial(trialEndsAt)), umInstanteAntes).allowed).toBe(true);
    expect(resolveServiceEntitlement(est(trial(trialEndsAt)), noLimite).allowed).toBe(false);
  });
});
