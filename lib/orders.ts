import { db, sub } from "@/lib/firebase/admin";
import type { DeliveryFeeRule, FoodOrder, MenuCategory, MenuProduct, OrderItem, OrderPaymentMethod, OrderSettings, OrderStatus } from "@/types";
import { normalizePhone } from "@/lib/whatsapp/client";

const ACTIVE_DRAFT = new Set<OrderStatus>(["draft", "awaiting_confirmation"]);
const TERMINAL = new Set<OrderStatus>(["completed", "cancelled", "rejected"]);
export const defaultOrderSettings = (): OrderSettings => ({ pickupEnabled: true, deliveryEnabled: false, deliveryRules: [{ kind: "fixed", feeCents: 0 }], acceptedPaymentMethods: ["pix", "cash", "credit_card", "debit_card"], pixInstructions: null });

const cents = (value: unknown) => Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
const text = (value: unknown, max = 160) => typeof value === "string" ? value.trim().slice(0, max) : "";
const orderRef = (establishmentId: string, orderId: string) => sub(establishmentId, "orders").doc(orderId);

export function normalizeOrderSettings(input: Partial<OrderSettings>): OrderSettings {
  const validMethods: OrderPaymentMethod[] = ["pix", "cash", "credit_card", "debit_card"];
  const rules: DeliveryFeeRule[] = Array.isArray(input.deliveryRules) ? input.deliveryRules.reduce<DeliveryFeeRule[]>((all, rule) => {
    const feeCents = cents(rule?.feeCents);
    if (feeCents === null) return all;
    if (rule.kind === "neighborhood" && text(rule.neighborhood, 80)) all.push({ kind: "neighborhood", neighborhood: text(rule.neighborhood, 80), feeCents });
    if (rule.kind === "fixed") all.push({ kind: "fixed", feeCents });
    return all;
  }, []) : defaultOrderSettings().deliveryRules;
  return {
    pickupEnabled: input.pickupEnabled !== false,
    deliveryEnabled: Boolean(input.deliveryEnabled),
    deliveryRules: rules.length ? rules : [{ kind: "fixed", feeCents: 0 }],
    acceptedPaymentMethods: Array.isArray(input.acceptedPaymentMethods) ? input.acceptedPaymentMethods.filter((m): m is OrderPaymentMethod => validMethods.includes(m as OrderPaymentMethod)) : defaultOrderSettings().acceptedPaymentMethods,
    pixInstructions: text(input.pixInstructions, 500) || null,
  };
}

export async function getOrderSettings(establishmentId: string): Promise<OrderSettings> {
  const snap = await sub(establishmentId, "meta").doc("orders").get();
  return snap.exists ? normalizeOrderSettings(snap.data() as Partial<OrderSettings>) : defaultOrderSettings();
}
export async function saveOrderSettings(establishmentId: string, input: Partial<OrderSettings>): Promise<OrderSettings> {
  const settings = normalizeOrderSettings(input);
  await sub(establishmentId, "meta").doc("orders").set(settings);
  return settings;
}

export async function listMenuCategories(establishmentId: string): Promise<MenuCategory[]> {
  const snap = await sub(establishmentId, "menuCategories").orderBy("sortOrder", "asc").limit(100).get();
  return snap.docs.map((d) => d.data() as MenuCategory);
}
export async function listMenuProducts(establishmentId: string): Promise<MenuProduct[]> {
  const snap = await sub(establishmentId, "menuProducts").orderBy("name", "asc").limit(300).get();
  return snap.docs.map((d) => d.data() as MenuProduct);
}
export async function getMenuProduct(establishmentId: string, productId: string): Promise<MenuProduct | null> {
  const snap = await sub(establishmentId, "menuProducts").doc(productId).get();
  return snap.exists ? snap.data() as MenuProduct : null;
}
export async function saveMenuCategory(establishmentId: string, input: Partial<MenuCategory>, id?: string): Promise<MenuCategory> {
  const now = Date.now(); const ref = id ? sub(establishmentId, "menuCategories").doc(id) : sub(establishmentId, "menuCategories").doc();
  const previous = id ? await ref.get() : null;
  const category: MenuCategory = { id: ref.id, name: text(input.name, 100), active: input.active !== false, sortOrder: Number.isInteger(input.sortOrder) ? Number(input.sortOrder) : 0, createdAt: previous?.exists ? (previous.data() as MenuCategory).createdAt : now, updatedAt: now };
  if (!category.name) throw new Error("Nome da categoria é obrigatório.");
  await ref.set(category); return category;
}
export function normalizeProduct(input: Partial<MenuProduct>, id: string, now: number, createdAt = now): MenuProduct {
  const price = cents(input.basePriceCents); if (price === null) throw new Error("Preço base inválido.");
  const variants = Array.isArray(input.variants) ? input.variants.flatMap((v, index) => { const delta = cents(v?.priceDeltaCents); const name = text(v?.name, 100); return delta === null || !name ? [] : [{ id: text(v?.id, 80) || `variant-${index + 1}`, name, priceDeltaCents: delta, active: v?.active !== false }]; }) : [];
  const modifierGroups = Array.isArray(input.modifierGroups) ? input.modifierGroups.flatMap((g, groupIndex) => {
    const options = Array.isArray(g?.options) ? g.options.flatMap((o, optionIndex) => { const delta = cents(o?.priceDeltaCents); const name = text(o?.name, 100); return delta === null || !name ? [] : [{ id: text(o?.id, 80) || `option-${groupIndex + 1}-${optionIndex + 1}`, name, priceDeltaCents: delta, active: o?.active !== false }]; }) : [];
    const max = Number.isInteger(g?.maxSelections) ? Math.max(0, Number(g.maxSelections)) : options.length;
    const min = Number.isInteger(g?.minSelections) ? Math.max(0, Math.min(Number(g.minSelections), max)) : (g?.required ? 1 : 0);
    const name = text(g?.name, 100); return name && options.length ? [{ id: text(g?.id, 80) || `group-${groupIndex + 1}`, name, required: Boolean(g?.required), minSelections: min, maxSelections: max, options }] : [];
  }) : [];
  const name = text(input.name, 120); if (!name || !text(input.categoryId, 100)) throw new Error("Produto e categoria são obrigatórios.");
  return { id, categoryId: text(input.categoryId, 100), name, description: text(input.description, 500) || null, basePriceCents: price, active: input.active !== false, variants, modifierGroups, createdAt, updatedAt: now };
}
export async function saveMenuProduct(establishmentId: string, input: Partial<MenuProduct>, id?: string): Promise<MenuProduct> {
  const ref = id ? sub(establishmentId, "menuProducts").doc(id) : sub(establishmentId, "menuProducts").doc(); const old = id ? await ref.get() : null;
  const product = normalizeProduct(input, ref.id, Date.now(), old?.exists ? (old.data() as MenuProduct).createdAt : Date.now()); await ref.set(product); return product;
}

export function calculateItem(product: MenuProduct, variantId: string | null | undefined, optionIds: string[], quantity: number, notes?: string | null): OrderItem {
  if (!product.active) throw new Error("Produto indisponível.");
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("Quantidade inválida.");
  const variant = variantId ? product.variants.find((v) => v.id === variantId && v.active) : undefined;
  if (variantId && !variant) throw new Error("Variação indisponível.");
  const unique = [...new Set(optionIds)]; const modifiers: OrderItem["modifiers"] = [];
  for (const group of product.modifierGroups) {
    const selected = unique.map((id) => group.options.find((o) => o.id === id && o.active)).filter(Boolean) as NonNullable<typeof group.options[number]>[];
    if (selected.length < group.minSelections || selected.length > group.maxSelections) throw new Error(`Seleção inválida em ${group.name}.`);
    modifiers.push(...selected.map((o) => ({ optionId: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents })));
  }
  const unknown = unique.filter((id) => !modifiers.some((m) => m.optionId === id)); if (unknown.length) throw new Error("Adicional indisponível.");
  const unitPriceCents = product.basePriceCents + (variant?.priceDeltaCents ?? 0) + modifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0);
  return { id: "", productId: product.id, productName: product.name, variantId: variant?.id ?? null, variantName: variant?.name ?? null, quantity, unitPriceCents, modifiers, notes: text(notes, 300) || null, lineTotalCents: unitPriceCents * quantity };
}
export function deliveryFee(settings: OrderSettings, fulfillment: FoodOrder["fulfillment"], neighborhood?: string | null): number {
  if (fulfillment !== "delivery") return 0;
  if (!settings.deliveryEnabled) throw new Error("Entrega não está disponível.");
  const key = text(neighborhood, 80).toLocaleLowerCase("pt-BR");
  const rule = settings.deliveryRules.find((r) => r.kind === "neighborhood" && r.neighborhood.toLocaleLowerCase("pt-BR") === key) ?? settings.deliveryRules.find((r) => r.kind === "fixed");
  if (!rule) throw new Error("Não há taxa configurada para esse endereço."); return rule.feeCents;
}
function recalculate(order: FoodOrder, settings: OrderSettings): FoodOrder {
  const subtotalCents = order.items.reduce((sum, item) => sum + item.lineTotalCents, 0); const deliveryFeeCents = deliveryFee(settings, order.fulfillment, order.deliveryAddress?.neighborhood);
  return { ...order, subtotalCents, deliveryFeeCents, totalCents: subtotalCents + deliveryFeeCents };
}
async function draftFor(establishmentId: string, conversationId: string, contactPhone: string, contactName: string | null, operationId?: string, allowCreateAfterConfirmation = false): Promise<FoodOrder> {
  const conversationRef = sub(establishmentId, "conversations").doc(conversationId);
  return db.runTransaction(async (tx) => {
    const conversation = await tx.get(conversationRef); const state = conversation.exists ? (conversation.data() as { activeOrderId?: string; lastConfirmedOrderId?: string }) : {}; const activeOrderId = state.activeOrderId;
    if (activeOrderId) { const active = await tx.get(orderRef(establishmentId, activeOrderId)); if (active.exists && ACTIVE_DRAFT.has((active.data() as FoodOrder).status)) return active.data() as FoodOrder; }
    if (state.lastConfirmedOrderId) {
      const confirmed = await tx.get(orderRef(establishmentId, state.lastConfirmedOrderId));
      if (confirmed.exists && operationId && (confirmed.data() as FoodOrder).appliedOperationIds?.includes(operationId)) return confirmed.data() as FoodOrder;
      if (!allowCreateAfterConfirmation) throw new Error("O pedido anterior já foi confirmado; inicie um novo pedido explicitamente.");
    }
    const ref = sub(establishmentId, "orders").doc(); const now = Date.now();
    const order: FoodOrder = { id: ref.id, establishmentId, conversationId, contactPhone: normalizePhone(contactPhone), contactName, status: "draft", fulfillment: null, deliveryAddress: null, deliveryFeeCents: 0, payment: { method: null, status: "unpaid", changeForCents: null }, items: [], subtotalCents: 0, totalCents: 0, version: 1, createdAt: now, updatedAt: now, confirmedAt: null };
    tx.set(ref, order); tx.set(conversationRef, { activeOrderId: ref.id }, { merge: true }); return order;
  });
}
async function mutateDraft(establishmentId: string, conversationId: string, contactPhone: string, contactName: string | null, operationId: string | undefined, mutation: (order: FoodOrder, settings: OrderSettings) => Promise<FoodOrder> | FoodOrder, allowCreateAfterConfirmation = false): Promise<FoodOrder> {
  const draft = await draftFor(establishmentId, conversationId, contactPhone, contactName, operationId, allowCreateAfterConfirmation); const ref = orderRef(establishmentId, draft.id); const settings = await getOrderSettings(establishmentId);
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new Error("Pedido não encontrado."); const current = snap.data() as FoodOrder; if (operationId && current.appliedOperationIds?.includes(operationId)) return current; if (!ACTIVE_DRAFT.has(current.status)) throw new Error("Este pedido não pode mais ser alterado."); const changed = await mutation(current, settings); const updated = { ...recalculate(changed, settings), status: "draft" as const, version: current.version + 1, appliedOperationIds: operationId ? [...(current.appliedOperationIds ?? []).slice(-49), operationId] : current.appliedOperationIds, updatedAt: Date.now() }; tx.set(ref, updated); return updated; });
}
export async function addOrderItem(establishmentId: string, conversationId: string, phone: string, name: string | null, productId: string, variantId: string | null, modifierOptionIds: string[], quantity: number, notes?: string | null, operationId?: string, allowCreateAfterConfirmation = false) {
  const product = await getMenuProduct(establishmentId, productId); if (!product) throw new Error("Produto não encontrado."); const item = calculateItem(product, variantId, modifierOptionIds, quantity, notes); item.id = sub(establishmentId, "orders").doc().id;
  return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => ({ ...order, items: [...order.items, item] }), allowCreateAfterConfirmation);
}
export async function updateOrderItem(establishmentId: string, conversationId: string, phone: string, name: string | null, itemId: string, input: { quantity?: number; notes?: string | null }, operationId?: string) {
  return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => { const item = order.items.find((i) => i.id === itemId); if (!item) throw new Error("Item não encontrado."); const quantity = input.quantity ?? item.quantity; if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("Quantidade inválida."); const next = { ...item, quantity, notes: input.notes === undefined ? item.notes : text(input.notes, 300) || null, lineTotalCents: item.unitPriceCents * quantity }; return { ...order, items: order.items.map((i) => i.id === itemId ? next : i) }; });
}
export async function removeOrderItem(establishmentId: string, conversationId: string, phone: string, name: string | null, itemId: string, operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => order.items.some((i) => i.id === itemId) ? { ...order, items: order.items.filter((i) => i.id !== itemId) } : (() => { throw new Error("Item não encontrado."); })()); }
export async function setOrderFulfillment(establishmentId: string, conversationId: string, phone: string, name: string | null, fulfillment: "pickup" | "delivery", operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order, settings) => { if (fulfillment === "pickup" && !settings.pickupEnabled) throw new Error("Retirada não está disponível."); if (fulfillment === "delivery" && !settings.deliveryEnabled) throw new Error("Entrega não está disponível."); return { ...order, fulfillment, deliveryAddress: fulfillment === "pickup" ? null : order.deliveryAddress }; }); }
export async function setOrderAddress(establishmentId: string, conversationId: string, phone: string, name: string | null, raw: string, neighborhood?: string | null, reference?: string | null, operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => { if (order.fulfillment !== "delivery") throw new Error("Escolha entrega antes de informar o endereço."); if (!text(raw, 500)) throw new Error("Endereço é obrigatório."); return { ...order, deliveryAddress: { raw: text(raw, 500), neighborhood: text(neighborhood, 80) || null, reference: text(reference, 160) || null } }; }); }
export async function setOrderPayment(establishmentId: string, conversationId: string, phone: string, name: string | null, method: OrderPaymentMethod, changeForCents?: number | null, operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order, settings) => { if (!settings.acceptedPaymentMethods.includes(method)) throw new Error("Forma de pagamento não aceita."); const change = changeForCents == null ? null : cents(changeForCents); if (changeForCents != null && change === null) throw new Error("Troco inválido."); return { ...order, payment: { method, status: method === "pix" ? "pending" : "unpaid", changeForCents: change } }; }); }
export async function getOrder(establishmentId: string, orderId: string) { const snap = await orderRef(establishmentId, orderId).get(); return snap.exists ? snap.data() as FoodOrder : null; }
export async function getActiveOrder(establishmentId: string, conversationId: string) { const conv = await sub(establishmentId, "conversations").doc(conversationId).get(); const id = conv.exists ? (conv.data() as { activeOrderId?: string }).activeOrderId : undefined; return id ? getOrder(establishmentId, id) : null; }
export async function confirmOrder(establishmentId: string, orderId: string, expectedVersion: number, phone: string): Promise<FoodOrder> {
  const ref = orderRef(establishmentId, orderId); const settings = await getOrderSettings(establishmentId);
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new Error("Pedido não encontrado."); const order = snap.data() as FoodOrder; if (normalizePhone(order.contactPhone) !== normalizePhone(phone)) throw new Error("Pedido não pertence a este cliente."); if (order.status === "confirmed") return order; if (!ACTIVE_DRAFT.has(order.status) || order.version !== expectedVersion) throw new Error("O pedido mudou; confira o resumo atualizado antes de confirmar."); if (!order.items.length || !order.fulfillment || !order.payment.method || (order.fulfillment === "delivery" && !order.deliveryAddress)) throw new Error("Faltam dados para confirmar o pedido.");
    // Rele produto, variante e adicionais na mesma transação. Uma mudança de
    // catálogo não pode confirmar um snapshot antigo com preço ou composição
    // diferente; o cliente precisa receber um resumo novo, nunca um total
    // silenciosamente alterado.
    for (const item of order.items) {
      const productSnap = await tx.get(sub(establishmentId, "menuProducts").doc(item.productId));
      if (!productSnap.exists) throw new Error(`${item.productName} não está mais disponível.`);
      const product = productSnap.data() as MenuProduct;
      let current: OrderItem;
      try { current = calculateItem(product, item.variantId, item.modifiers.map((m) => m.optionId), item.quantity, item.notes); }
      catch { throw new Error(`${item.productName} mudou ou não está mais disponível.`); }
      if (current.unitPriceCents !== item.unitPriceCents || current.lineTotalCents !== item.lineTotalCents || current.productName !== item.productName) {
        throw new Error(`${item.productName} mudou de preço; confira o resumo atualizado antes de confirmar.`);
      }
    }
    const now = Date.now(); const confirmed = { ...recalculate(order, settings), status: "confirmed" as const, version: order.version + 1, confirmedAt: now, updatedAt: now }; tx.set(ref, confirmed); tx.set(sub(establishmentId, "conversations").doc(order.conversationId), { activeOrderId: null, lastConfirmedOrderId: order.id }, { merge: true }); return confirmed;
  });
}
const TRANSITIONS: Partial<Record<OrderStatus, OrderStatus[]>> = { confirmed: ["accepted", "rejected", "cancelled"], accepted: ["preparing", "cancelled"], preparing: ["ready_for_pickup", "out_for_delivery", "cancelled"], ready_for_pickup: ["completed", "cancelled"], out_for_delivery: ["completed", "cancelled"] };
export async function transitionOrder(establishmentId: string, orderId: string, status: OrderStatus): Promise<FoodOrder> { const ref = orderRef(establishmentId, orderId); return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new Error("Pedido não encontrado."); const order = snap.data() as FoodOrder; if (order.status === status) return order; if (!TRANSITIONS[order.status]?.includes(status)) throw new Error("Transição de status inválida."); const next = { ...order, status, updatedAt: Date.now(), version: order.version + 1 }; tx.set(ref, next); return next; }); }
export async function listOrders(establishmentId: string): Promise<FoodOrder[]> { const snap = await sub(establishmentId, "orders").orderBy("createdAt", "desc").limit(200).get(); return snap.docs.map((d) => d.data() as FoodOrder); }
