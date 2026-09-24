// Risco 6 no atalho de lembrete: a confirmação de presença usava
// `includes("isso")`, então uma NEGAÇÃO era lida como confirmação:
//
//   "não é isso"    -> confirm
//   "não, isso não" -> confirm
//
import { describe, expect, it } from "vitest";
import { confirmCancelReminderIntent } from "./reminderConfirmation";

describe("atalho de lembrete: negação nunca vira confirmação de presença", () => {
  it.each(["não é isso", "nao e isso", "não, isso não", "deixa pra lá"])("'%s' não confirma", (texto) => {
    expect(confirmCancelReminderIntent(texto)).not.toBe("confirm");
  });

  it("ambíguo também não confirma presença sozinho", () => {
    expect(confirmCancelReminderIntent("acho que sim")).toBeNull();
    expect(confirmCancelReminderIntent("talvez")).toBeNull();
    expect(confirmCancelReminderIntent("isso")).toBeNull();
  });
});

describe("atalho de lembrete: comportamento preservado", () => {
  it("confirmações inequívocas seguem confirmando", () => {
    for (const texto of ["sim", "confirmo", "pode confirmar", "isso mesmo", "ok"]) {
      expect(confirmCancelReminderIntent(texto), texto).toBe("confirm");
    }
  });

  it("pedido explícito de cancelamento continua sendo cancelamento", () => {
    for (const texto of ["cancelar", "cancela esse", "desmarca", "não vou poder ir"]) {
      expect(confirmCancelReminderIntent(texto), texto).toBe("cancel");
    }
  });

  it("cancelamento tem prioridade sobre confirmação, como antes", () => {
    expect(confirmCancelReminderIntent("sim, pode cancelar")).toBe("cancel");
  });

  it("resposta longa continua sendo deixada para a IA", () => {
    expect(confirmCancelReminderIntent("sim eu confirmo minha presença na consulta de amanhã cedo obrigado")).toBeNull();
  });
});

describe("atalho de lembrete: cancelamento só com intenção positiva e inequívoca", () => {
  it.each(["cancelar", "pode cancelar", "quero cancelar", "não vou conseguir ir, pode cancelar"])("'%s' cancela", (texto) => {
    expect(confirmCancelReminderIntent(texto)).toBe("cancel");
  });

  it.each(["não precisa cancelar", "não quero cancelar", "não cancele", "pode deixar marcado", "vou comparecer", "ainda não sei se vou cancelar"])(
    "'%s' não cancela",
    (texto) => {
      expect(confirmCancelReminderIntent(texto)).not.toBe("cancel");
    },
  );

  it.each([
    "Não vou.",
    "Quero remarcar.",
    "Pode mudar para amanhã?",
    "Esse horário não dá, tem outro?",
  ])("'%s' segue para o fluxo de remarcação, nunca cancela", (texto) => {
    expect(confirmCancelReminderIntent(texto)).toBeNull();
  });
});
