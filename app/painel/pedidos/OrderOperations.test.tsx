// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OrderOperations } from "./OrderOperations";
import type { FoodOrder, OrderStatus } from "@/types";

function order(status: OrderStatus = "confirmed", fulfillment: "pickup" | "delivery" = "pickup"): FoodOrder {
  const snapshot = {
    items: [{ id: "snap-item", productId: "p1", productName: "X-Burguer confirmado", variantId: "large", variantName: "Grande", quantity: 2, unitPriceCents: 2500, modifiers: [{ optionId: "bacon", name: "Bacon", priceDeltaCents: 400 }], notes: "sem cebola", lineTotalCents: 5000 }],
    subtotalCents: 5000, discountCents: 500, deliveryFeeCents: fulfillment === "delivery" ? 700 : 0, totalCents: fulfillment === "delivery" ? 5200 : 4500,
    fulfillment, deliveryAddress: fulfillment === "delivery" ? { raw: "Rua A, 10", neighborhood: "Centro", reference: "Portão azul" } : null,
    payment: { method: "pix" as const, status: "pending" as const, changeForCents: null }, createdAt: 1000,
  };
  return {
    id: "order-ABC123", establishmentId: "est-1", conversationId: "conv-1", contactPhone: "5511999990000", contactName: "Cliente",
    status, fulfillment, deliveryAddress: snapshot.deliveryAddress, deliveryFeeCents: snapshot.deliveryFeeCents, discountCents: snapshot.discountCents,
    payment: snapshot.payment, items: [{ ...snapshot.items[0]!, productName: "Nome atual que não deve aparecer" }], subtotalCents: 9999, totalCents: 9999,
    version: 4, confirmationRequestedAt: 900, snapshot, operationalHistory: [{ from: "awaiting_confirmation", to: "confirmed", at: 1000, source: "customer_confirmation" }],
    createdAt: 500, updatedAt: 1000, confirmedAt: 1000,
  };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("operação de pedidos no painel", () => {
  it("mostra confirmados e não mostra draft/awaiting_confirmation", () => {
    render(<OrderOperations orders={[order(), order("draft"), order("awaiting_confirmation")]} onOrderUpdated={vi.fn()} />);
    expect(screen.getByText(/#ABC123/)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Ativos (1)" })).toBeTruthy();
    expect(screen.queryByText("Rascunho")).toBeNull();
    expect(screen.queryByText("Aguardando confirmação")).toBeNull();
  });

  it("usa o snapshot confirmado nos detalhes, não os dados mutáveis do pedido", () => {
    render(<OrderOperations orders={[order("confirmed", "delivery")]} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Ver detalhes" }));
    expect(screen.getByText(/X-Burguer confirmado/)).toBeTruthy();
    expect(screen.queryByText(/Nome atual que não deve aparecer/)).toBeNull();
    expect(screen.getByText(/Bacon/)).toBeTruthy();
    expect(screen.getByText(/sem cebola/)).toBeTruthy();
    expect(screen.getByText(/Rua A, 10/)).toBeTruthy();
    expect(screen.getAllByText(/52,00/).length).toBeGreaterThan(0);
  });

  it("oferece a próxima ação conforme modalidade e envia a versão observada", async () => {
    const delivery = order("ready_for_pickup", "delivery");
    const updated = { ...delivery, status: "out_for_delivery" as const, version: 5 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ order: updated }) });
    vi.stubGlobal("fetch", fetchMock);
    const onOrderUpdated = vi.fn();
    render(<OrderOperations orders={[delivery]} onOrderUpdated={onOrderUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "Saiu para entrega" }));
    await waitFor(() => expect(onOrderUpdated).toHaveBeenCalledWith(updated));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ status: "out_for_delivery", expectedVersion: 4 });
  });

  it("retirada pronta oferece concluir e nunca oferece saiu para entrega", () => {
    render(<OrderOperations orders={[order("ready_for_pickup", "pickup")]} onOrderUpdated={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Concluir pedido" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Saiu para entrega" })).toBeNull();
  });

  it("exige confirmação antes de cancelar", async () => {
    const current = order(); const updated = { ...current, status: "cancelled" as const, version: 5 };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ order: updated }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<OrderOperations orders={[current]} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirmar cancelamento" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).status).toBe("cancelled");
  });

  it("erro do backend não produz falso sucesso", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "O pedido foi atualizado por outro operador." }) }));
    const onOrderUpdated = vi.fn();
    render(<OrderOperations orders={[order()]} onOrderUpdated={onOrderUpdated} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceitar pedido" }));
    expect((await screen.findByRole("alert")).textContent).toContain("atualizado por outro operador");
    expect(onOrderUpdated).not.toHaveBeenCalled();
    expect(screen.getByText("Novo")).toBeTruthy();
  });

  it("distingue status salvo de falha posterior da notificação", async () => {
    const current = order(); const updated = { ...current, status: "accepted" as const, version: 5 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ order: updated, notification: { status: "failed" } }) }));
    render(<OrderOperations orders={[current]} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Aceitar pedido" }));
    expect((await screen.findByRole("status")).textContent).toContain("Pedido atualizado");
    expect(screen.getByRole("status").textContent).toContain("Não foi possível enviar");
  });

  it("separa encerrados da fila ativa", () => {
    render(<OrderOperations orders={[order(), { ...order("completed"), id: "order-DONE99" }]} onOrderUpdated={vi.fn()} />);
    expect(screen.queryByText(/DONE99/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Encerrados (1)" }));
    expect(screen.getByText(/DONE99/)).toBeTruthy();
    expect(screen.queryByText(/ABC123/)).toBeNull();
  });
});
