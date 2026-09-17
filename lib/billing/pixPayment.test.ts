import { describe, expect, it, vi } from "vitest";
import { resolvePixPaymentForSubscription, type ResolvePixPaymentDeps } from "./pixPayment";
import type { AsaasPayment, AsaasPixQrCode, AsaasResult } from "./asaas";

function ok<T>(data: T): AsaasResult<T> {
  return { ok: true, data };
}
function httpError(status: number): AsaasResult<never> {
  return { ok: false, error: { kind: "http", status, message: "x" } };
}

function deps(over: Partial<ResolvePixPaymentDeps["asaas"]> = {}): ResolvePixPaymentDeps {
  return {
    asaas: {
      listSubscriptionPayments: vi.fn(async () => ok<AsaasPayment[]>([])),
      getPixQrCode: vi.fn(async () => ok<AsaasPixQrCode>({ encodedImage: "img", payload: "copia-cola" })),
      ...over,
    },
  };
}

const SUB_ID = "sub_est_1";
const DUE_DATE = "2026-09-17";

describe("resolvePixPaymentForSubscription", () => {
  it("cobrança pertence à subscription correta: consulta escopada só por subscriptionId", async () => {
    const list = vi.fn(async () => ok<AsaasPayment[]>([{ id: "pay_1", dueDate: DUE_DATE }]));
    const d = deps({ listSubscriptionPayments: list });
    await resolvePixPaymentForSubscription(d, { subscriptionId: SUB_ID, nextDueDate: DUE_DATE });
    expect(list).toHaveBeenCalledWith(SUB_ID);
  });

  it("match único por nextDueDate -> busca o QR e retorna pronto", async () => {
    const list = vi.fn(async () => ok<AsaasPayment[]>([
      { id: "pay_other", dueDate: "2026-10-17" },
      { id: "pay_1", dueDate: DUE_DATE },
    ]));
    const qr = vi.fn(async () => ok<AsaasPixQrCode>({ encodedImage: "IMG64", payload: "PIX_COPY", expirationDate: "2026-09-18" }));
    const r = await resolvePixPaymentForSubscription(deps({ listSubscriptionPayments: list, getPixQrCode: qr }), {
      subscriptionId: SUB_ID,
      nextDueDate: DUE_DATE,
    });
    expect(r).toEqual({ ok: true, status: "ready", pixCopyPaste: "PIX_COPY", qrCode: "IMG64", expiresAt: "2026-09-18" });
    expect(qr).toHaveBeenCalledWith("pay_1");
  });

  it("nenhuma cobrança ainda (corrida pós-criação): not_generated_yet, sem crash", async () => {
    const r = await resolvePixPaymentForSubscription(deps(), { subscriptionId: SUB_ID, nextDueDate: DUE_DATE });
    expect(r).toEqual({ ok: true, status: "not_generated_yet" });
  });

  it("mais de uma cobrança com o mesmo nextDueDate: recusa ambiguidade, nunca adivinha", async () => {
    const list = vi.fn(async () => ok<AsaasPayment[]>([
      { id: "pay_a", dueDate: DUE_DATE },
      { id: "pay_b", dueDate: DUE_DATE },
    ]));
    const qr = vi.fn();
    const r = await resolvePixPaymentForSubscription(deps({ listSubscriptionPayments: list, getPixQrCode: qr }), {
      subscriptionId: SUB_ID,
      nextDueDate: DUE_DATE,
    });
    expect(r).toEqual({ ok: false, reason: "ambiguous_payment" });
    expect(qr).not.toHaveBeenCalled();
  });

  it("falha ao listar cobranças: lookup_failed, sanitizado", async () => {
    const r = await resolvePixPaymentForSubscription(
      deps({ listSubscriptionPayments: vi.fn(async () => httpError(500)) }),
      { subscriptionId: SUB_ID, nextDueDate: DUE_DATE },
    );
    expect(r).toEqual({ ok: false, reason: "lookup_failed" });
  });

  it("falha ao buscar QR: qrcode_failed, sanitizado", async () => {
    const list = vi.fn(async () => ok<AsaasPayment[]>([{ id: "pay_1", dueDate: DUE_DATE }]));
    const r = await resolvePixPaymentForSubscription(
      deps({ listSubscriptionPayments: list, getPixQrCode: vi.fn(async () => httpError(404)) }),
      { subscriptionId: SUB_ID, nextDueDate: DUE_DATE },
    );
    expect(r).toEqual({ ok: false, reason: "qrcode_failed" });
  });
});
