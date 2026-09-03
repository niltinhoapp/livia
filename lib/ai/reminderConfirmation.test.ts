// Risco 6 no atalho de lembrete: a confirmação de presença usava
// `includes("isso")`, então uma NEGAÇÃO era lida como confirmação:
//
//   "não é isso"    -> confirm
//   "não, isso não" -> confirm
//
// Este arquivo replica a função do webhook (mesma forma, agora apoiada em
// readConfirmation) para travar o comportamento sem precisar levantar todo o
// handler HTTP. O fluxo de lembrete em si não mudou: pedido explícito de
// cancelamento continua sendo detectado do mesmo jeito, e reminderSentAt não
// foi tocado.
import { describe, expect, it } from "vitest";
import { readConfirmation } from "./confirmation";

// Cópia fiel de confirmCancelIntent em app/api/webhooks/whatsapp/route.ts.
function confirmCancelIntent(text: string): "confirm" | "cancel" | null {
  const t = text.trim().toLowerCase();
  if (t.length > 30) return null;
  const cancel = ["cancelar", "cancela", "cancelado", "nao vou", "não vou", "desmarcar", "desmarca", "nao poderei", "não poderei"];
  if (cancel.some((w) => t.includes(w))) return "cancel";
  return readConfirmation(t) === "yes" ? "confirm" : null;
}

describe("atalho de lembrete: negação nunca vira confirmação de presença", () => {
  it.each(["não é isso", "nao e isso", "não, isso não", "deixa pra lá"])("'%s' não confirma", (texto) => {
    expect(confirmCancelIntent(texto)).not.toBe("confirm");
  });

  it("ambíguo também não confirma presença sozinho", () => {
    expect(confirmCancelIntent("acho que sim")).toBeNull();
    expect(confirmCancelIntent("talvez")).toBeNull();
    expect(confirmCancelIntent("isso")).toBeNull();
  });
});

describe("atalho de lembrete: comportamento preservado", () => {
  it("confirmações inequívocas seguem confirmando", () => {
    for (const texto of ["sim", "confirmo", "pode confirmar", "isso mesmo", "ok"]) {
      expect(confirmCancelIntent(texto), texto).toBe("confirm");
    }
  });

  it("pedido explícito de cancelamento continua sendo cancelamento", () => {
    for (const texto of ["cancelar", "cancela esse", "desmarca", "não vou poder ir"]) {
      expect(confirmCancelIntent(texto), texto).toBe("cancel");
    }
  });

  it("cancelamento tem prioridade sobre confirmação, como antes", () => {
    expect(confirmCancelIntent("sim, pode cancelar")).toBe("cancel");
  });

  it("resposta longa continua sendo deixada para a IA", () => {
    expect(confirmCancelIntent("sim eu confirmo minha presença na consulta de amanhã cedo obrigado")).toBeNull();
  });
});
