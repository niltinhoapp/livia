import { describe, expect, it } from "vitest";
import {
  TRIAL_GRACE_WINDOW_MS,
  TRIAL_PAYMENT_WINDOW_MS,
  resolveTrialPhase,
  trialAllowsAccess,
  trialAllowsPaymentCreation,
} from "./trialWindow";

const DAY = 24 * 60 * 60 * 1000;
const TRIAL_ENDS_AT = Date.UTC(2026, 8, 26, 12, 0, 0); // instante de referência fixo

describe("resolveTrialPhase — limites auditados um a um", () => {
  it("muito antes de trialEndsAt-24h -> before_window", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT - 6 * DAY)).toBe("before_window");
  });

  it("1ms antes de trialEndsAt-24h -> before_window (ainda bloqueado)", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT - TRIAL_PAYMENT_WINDOW_MS - 1)).toBe("before_window");
  });

  it("exatamente em trialEndsAt-24h -> final_day (pagamento já liberado)", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT - TRIAL_PAYMENT_WINDOW_MS)).toBe("final_day");
  });

  it("1ms antes de trialEndsAt -> final_day (ainda dentro do último dia)", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT - 1)).toBe("final_day");
  });

  it("exatamente em trialEndsAt -> grace (NÃO expira aqui)", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT)).toBe("grace");
  });

  it("no meio da janela de 24h seguinte -> grace", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT + 12 * 60 * 60 * 1000)).toBe("grace");
  });

  it("1ms antes de trialEndsAt+24h -> grace (ainda não expirou)", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT + TRIAL_GRACE_WINDOW_MS - 1)).toBe("grace");
  });

  it("exatamente em trialEndsAt+24h -> expired", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT + TRIAL_GRACE_WINDOW_MS)).toBe("expired");
  });

  it("muito depois de trialEndsAt+24h -> expired", () => {
    expect(resolveTrialPhase(TRIAL_ENDS_AT, TRIAL_ENDS_AT + 10 * DAY)).toBe("expired");
  });
});

describe("trialAllowsPaymentCreation", () => {
  it("before_window: pagamento bloqueado", () => {
    expect(trialAllowsPaymentCreation("before_window")).toBe(false);
  });
  it("final_day/grace/expired: pagamento liberado (inclusive pra regularizar após suspensão)", () => {
    expect(trialAllowsPaymentCreation("final_day")).toBe(true);
    expect(trialAllowsPaymentCreation("grace")).toBe(true);
    expect(trialAllowsPaymentCreation("expired")).toBe(true);
  });
});

describe("trialAllowsAccess", () => {
  it("before_window/final_day/grace: acesso mantido", () => {
    expect(trialAllowsAccess("before_window")).toBe(true);
    expect(trialAllowsAccess("final_day")).toBe(true);
    expect(trialAllowsAccess("grace")).toBe(true);
  });
  it("expired: acesso bloqueado", () => {
    expect(trialAllowsAccess("expired")).toBe(false);
  });
});
