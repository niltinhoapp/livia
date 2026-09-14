import { describe, expect, it } from "vitest";
import { mapErrorToPhase } from "./errorMapping";

describe("mapErrorToPhase — beta fechado", () => {
  it("mapeia o erro de domínio para a mensagem específica de vagas preenchidas", () => {
    expect(mapErrorToPhase("BETA_COHORT_FULL")).toBe("beta-full");
  });
});
