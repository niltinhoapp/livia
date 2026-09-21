"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { FoodOrder, OrderStatus, OrderStatusNotification } from "@/types";
import { ACTIVE_ORDER_STATUSES, CLOSED_ORDER_STATUSES, primaryOrderTransition } from "@/lib/orderLifecycle";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/States";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";

const ACTIVE = new Set<OrderStatus>(ACTIVE_ORDER_STATUSES);
const CLOSED = new Set<OrderStatus>(CLOSED_ORDER_STATUSES);
const labels: Record<OrderStatus, { label: string; tone: StatusTone }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  awaiting_confirmation: { label: "Aguardando confirmação", tone: "warning" },
  confirmed: { label: "Novo", tone: "warning" },
  accepted: { label: "Aceito", tone: "info" },
  preparing: { label: "Em preparo", tone: "info" },
  ready_for_pickup: { label: "Pronto", tone: "success" },
  out_for_delivery: { label: "Saiu para entrega", tone: "info" },
  completed: { label: "Concluído", tone: "success" },
  cancelled: { label: "Cancelado", tone: "danger" },
  rejected: { label: "Recusado", tone: "danger" },
};
const paymentLabels = { pix: "Pix", cash: "Dinheiro", credit_card: "Cartão de crédito", debit_card: "Cartão de débito" } as const;
const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const when = (timestamp: number) => new Date(timestamp).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
const number = (order: FoodOrder) => `#${order.id.slice(-6).toUpperCase()}`;

function elapsed(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes < 1) return "agora";
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `há ${hours}h${String(minutes % 60).padStart(2, "0")}`;
}

export function OrderOperations({ orders, onOrderUpdated, onRefresh }: { orders: FoodOrder[]; onOrderUpdated: (order: FoodOrder) => void; onRefresh?: () => Promise<void> }) {
  const [tab, setTab] = useState<"active" | "closed">("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelOrder, setCancelOrder] = useState<FoodOrder | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [newOrderIds, setNewOrderIds] = useState<string[]>([]);
  const knownOrderIds = useRef<Set<string> | null>(null);
  const inFlightOrderIds = useRef(new Set<string>());
  const { operational, active, closed } = useMemo(() => {
    const operational = orders.filter((order) => ACTIVE.has(order.status) || CLOSED.has(order.status));
    return { operational, active: operational.filter((order) => ACTIVE.has(order.status)), closed: operational.filter((order) => CLOSED.has(order.status)) };
  }, [orders]);
  const shown = tab === "active" ? active : closed;
  const selected = operational.find((order) => order.id === selectedId) ?? null;
  const newOrders = useMemo(() => active.filter((order) => order.status === "confirmed" && newOrderIds.includes(order.id)), [active, newOrderIds]);

  useEffect(() => {
    const currentIds = new Set(operational.map((order) => order.id));
    if (knownOrderIds.current === null) {
      knownOrderIds.current = currentIds;
      return;
    }
    const incoming = operational.filter((order) => order.status === "confirmed" && !knownOrderIds.current!.has(order.id)).map((order) => order.id);
    if (incoming.length) setNewOrderIds((current) => [...new Set([...current, ...incoming])]);
    knownOrderIds.current = currentIds;
    setNewOrderIds((current) => {
      const next = current.filter((id) => currentIds.has(id) && operational.some((order) => order.id === id && order.status === "confirmed"));
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [operational]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  async function transition(order: FoodOrder, status: OrderStatus) {
    // Estado React ainda não necessariamente re-renderizou entre dois cliques
    // rápidos. A trava síncrona complementa o disabled visual; F6 continua
    // sendo a proteção definitiva entre abas/dispositivos.
    if (inFlightOrderIds.current.has(order.id)) return;
    inFlightOrderIds.current.add(order.id);
    setBusyId(order.id); setError(null); setNotice(null);
    try {
      const response = await fetch(`/api/orders/${order.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, expectedVersion: order.version }),
      });
      const body = await response.json().catch(() => ({})) as { order?: FoodOrder; notification?: OrderStatusNotification | null; notificationError?: boolean; error?: string };
      if (!response.ok || !body.order) {
        setError(body.error || "Não foi possível atualizar o pedido.");
        // Conflito F6: abandona a cópia velha e traz o estado autoritativo.
        if (response.status === 409) await onRefresh?.();
        return;
      }
      onOrderUpdated(body.order);
      setNewOrderIds((current) => current.filter((id) => id !== body.order!.id));
      if (body.notification && ["sent", "delivered", "read"].includes(body.notification.status)) {
        setNotice("Pedido atualizado e notificação enviada ao cliente.");
      } else if (body.notification?.status === "skipped") {
        setNotice("Pedido atualizado. Notificação não enviada: janela encerrada ou template indisponível.");
      } else if (body.notification?.status === "failed" || body.notificationError) {
        setNotice("Pedido atualizado. Falha ao enviar a notificação ao cliente.");
      } else if (body.notification || body.notificationError) {
        setNotice("Pedido atualizado. Notificação ainda pendente.");
      } else {
        setNotice("Pedido atualizado.");
      }
    } catch {
      setError("Não foi possível atualizar o pedido. Verifique a conexão e tente novamente.");
    } finally {
      inFlightOrderIds.current.delete(order.id);
      setBusyId(null);
    }
  }

  return <section>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-bold">Central operacional</h2><p className="text-sm text-ink-500">A fila é atualizada automaticamente enquanto esta tela estiver aberta.</p></div>
      <div className="flex gap-2" role="tablist" aria-label="Pedidos por situação">
        <Button size="sm" variant={tab === "active" ? "primary" : "secondary"} role="tab" aria-selected={tab === "active"} onClick={() => setTab("active")}>Ativos ({active.length})</Button>
        <Button size="sm" variant={tab === "closed" ? "primary" : "secondary"} role="tab" aria-selected={tab === "closed"} onClick={() => setTab("closed")}>Encerrados ({closed.length})</Button>
      </div>
    </div>
    {newOrders.length > 0 ? <div role="status" className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-card border border-primary/30 bg-primary-light/30 p-3 text-sm text-ink-800"><strong>{newOrders.length === 1 ? "Novo pedido aguardando aceite" : `${newOrders.length} novos pedidos aguardando aceite`}</strong><Button size="sm" variant="secondary" onClick={() => setNewOrderIds([])}>Marcar como vistos</Button></div> : null}
    {error ? <p role="alert" className="mb-3 rounded-control border border-danger/30 bg-danger-bg/40 p-3 text-sm text-danger-fg">{error}</p> : null}
    {notice ? <p role="status" className="mb-3 rounded-control border border-line bg-surface-subtle p-3 text-sm text-ink-600">{notice}</p> : null}
    {shown.length === 0 ? <EmptyState title={tab === "active" ? "Nenhum pedido ativo" : "Nenhum pedido encerrado"} description={tab === "active" ? "Pedidos confirmados pelo WhatsApp aparecem aqui." : "Pedidos concluídos ou cancelados ficam disponíveis para consulta."} /> : <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      <div className="space-y-3">{shown.map((order) => {
        const action = primaryOrderTransition(order);
        const isNew = newOrderIds.includes(order.id) && order.status === "confirmed";
        return <Card key={order.id} className={`p-4 ${selectedId === order.id ? "ring-2 ring-primary/30" : ""} ${isNew ? "border-primary/50 bg-primary-light/20" : ""}`}>
          <div className="flex justify-between gap-3"><div><p className="font-semibold">{number(order)} · {order.contactName ?? order.contactPhone}</p><p className="mt-1 text-xs text-ink-500">{when(order.confirmedAt ?? order.createdAt)} · {elapsed(order.confirmedAt ?? order.createdAt, now)} · {order.fulfillment === "delivery" ? "Entrega" : "Retirada"}</p></div><StatusBadge tone={labels[order.status].tone}>{isNew ? "Novo" : labels[order.status].label}</StatusBadge></div>
          <p className="mt-3 text-sm text-ink-600">{order.snapshot ? <>{order.snapshot.items.reduce((sum, item) => sum + item.quantity, 0)} item(ns) · <strong>{money(order.snapshot.totalCents)}</strong></> : <strong>Snapshot indisponível</strong>}</p>
          <div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => setSelectedId(order.id)}>Ver detalhes</Button>{action ? <Button size="sm" loading={busyId === order.id} onClick={() => void transition(order, action.status)}>{action.label}</Button> : null}{ACTIVE.has(order.status) ? <Button size="sm" variant="danger" disabled={busyId === order.id} onClick={() => setCancelOrder(order)}>Cancelar</Button> : null}</div>
        </Card>;
      })}</div>
      <div>{selected ? <OrderDetails order={selected} /> : <Card className="p-5 text-sm text-ink-500">Selecione um pedido para ver o snapshot e o histórico operacional.</Card>}</div>
    </div>}
    <ConfirmDialog open={Boolean(cancelOrder)} title="Cancelar pedido?" description={cancelOrder ? `O pedido ${number(cancelOrder)} será encerrado como cancelado. Essa ação operacional não realiza estorno ou reembolso.` : undefined} confirmLabel="Confirmar cancelamento" danger confirmDisabled={Boolean(cancelOrder && busyId === cancelOrder.id)} onCancel={() => setCancelOrder(null)} onConfirm={() => { if (!cancelOrder) return; const target = cancelOrder; setCancelOrder(null); void transition(target, "cancelled"); }} />
  </section>;
}

function OrderDetails({ order }: { order: FoodOrder }) {
  const snapshot = order.snapshot;
  return <Card className="p-5">
    <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-ink-400">Pedido {number(order)}</p><h3 className="mt-1 font-bold">{order.contactName ?? order.contactPhone}</h3><p className="text-xs text-ink-500">{when(order.confirmedAt ?? order.createdAt)}</p></div><StatusBadge tone={labels[order.status].tone}>{labels[order.status].label}</StatusBadge></div>
    {!snapshot ? <p className="mt-4 rounded-control bg-warning-bg/40 p-3 text-sm text-warning-fg">Snapshot confirmado indisponível para este pedido legado.</p> : <>
      <div className="mt-5 space-y-3">{snapshot.items.map((item) => <div key={item.id} className="border-b border-line/60 pb-3 last:border-0"><p className="font-semibold">{item.quantity}× {item.productName}{item.variantName ? ` · ${item.variantName}` : ""}</p>{item.modifiers.length ? <p className="text-sm text-ink-500">{item.modifiers.map((modifier) => modifier.name).join(", ")}</p> : null}{item.notes ? <p className="text-sm text-ink-500">Observação: {item.notes}</p> : null}<p className="mt-1 text-sm">{money(item.lineTotalCents)}</p></div>)}</div>
      <dl className="mt-4 space-y-1 text-sm"><div className="flex justify-between"><dt>Subtotal</dt><dd>{money(snapshot.subtotalCents)}</dd></div>{snapshot.discountCents ? <div className="flex justify-between"><dt>Desconto</dt><dd>− {money(snapshot.discountCents)}</dd></div> : null}<div className="flex justify-between"><dt>Taxa de entrega</dt><dd>{money(snapshot.deliveryFeeCents)}</dd></div><div className="flex justify-between border-t border-line pt-2 font-bold"><dt>Total</dt><dd>{money(snapshot.totalCents)}</dd></div></dl>
      <div className="mt-4 space-y-1 text-sm"><p><strong>Modalidade:</strong> {snapshot.fulfillment === "delivery" ? "Entrega" : "Retirada"}</p>{snapshot.fulfillment === "delivery" ? <p><strong>Endereço:</strong> {snapshot.deliveryAddress?.raw ?? "—"}{snapshot.deliveryAddress?.reference ? ` · ${snapshot.deliveryAddress.reference}` : ""}</p> : null}<p><strong>Pagamento:</strong> {paymentLabels[snapshot.payment.method]}{snapshot.payment.changeForCents ? ` · troco para ${money(snapshot.payment.changeForCents)}` : ""}</p></div>
    </>}
    <div className="mt-6 border-t border-line pt-4"><h4 className="font-semibold">Histórico operacional</h4>{order.operationalHistory?.length ? <ol className="mt-2 space-y-2 text-sm">{order.operationalHistory.map((entry, index) => <li key={`${entry.at}-${index}`}><span className="font-medium">{labels[entry.to].label}</span><span className="text-ink-500"> · {when(entry.at)}</span></li>)}</ol> : <p className="mt-2 text-sm text-ink-500">Sem histórico estruturado para este pedido legado.</p>}</div>
  </Card>;
}
