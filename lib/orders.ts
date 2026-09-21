import { db, sub } from "@/lib/firebase/admin";
import type { DeliveryFeeRule, FoodOrder, MenuCategory, MenuProduct, OrderItem, OrderPaymentMethod, OrderSettings, OrderStatus } from "@/types";
import { normalizePhone } from "@/lib/whatsapp/client";

const ACTIVE_DRAFT = new Set<OrderStatus>(["draft", "awaiting_confirmation"]);
const TERMINAL = new Set<OrderStatus>(["completed", "cancelled", "rejected"]);
const OPERATIONAL = new Set<OrderStatus>(["confirmed", "accepted", "preparing", "ready_for_pickup", "out_for_delivery", "completed", "cancelled", "rejected"]);
const ACTIVE_OPERATION_PRIORITY: Partial<Record<OrderStatus, number>> = { confirmed: 0, accepted: 1, preparing: 2, ready_for_pickup: 3, out_for_delivery: 4 };
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
export async function getMenuCategory(establishmentId: string, categoryId: string): Promise<MenuCategory | null> {
  const snap = await sub(establishmentId, "menuCategories").doc(categoryId).get();
  return snap.exists ? snap.data() as MenuCategory : null;
}

// Categoria desativada tira do ar TODOS os produtos dela. Antes, só
// `product.active` contava: desativar "Sobremesas" porque acabou o sorvete
// não impedia a Livia de seguir vendendo cada sobremesa individualmente.
//
// Categoria ausente não bloqueia de propósito — produto órfão (categoria
// removida ou catálogo legado) mantém o comportamento antigo, para que a
// correção não derrube venda de item que hoje funciona.
export function categoryBlocksSale(category: MenuCategory | null | undefined): boolean {
  return category ? category.active === false : false;
}

// Visão do catálogo para o caminho de PEDIDO (IA e montagem): só o que pode
// ser vendido agora. O painel continua usando listMenuProducts/getMenuProduct,
// que devolvem tudo — o comerciante precisa enxergar e reativar o que está
// desligado.
export async function listAvailableMenuProducts(establishmentId: string): Promise<MenuProduct[]> {
  const [products, categories] = await Promise.all([listMenuProducts(establishmentId), listMenuCategories(establishmentId)]);
  const blocked = new Set(categories.filter((c) => c.active === false).map((c) => c.id));
  return products.filter((p) => p.active && !blocked.has(p.categoryId));
}
// Cardápio inteiro, agrupado, só com o que pode ser vendido agora. Existe
// para a pergunta mais comum de lanchonete — "manda o cardápio" — que antes
// obrigava a IA a chutar uma palavra de busca e arriscava esconder categoria
// inteira (ninguém pergunta por "refrigerante" antes de ver que há bebidas).
export interface AvailableMenuCategory { id: string; name: string; products: MenuProduct[] }
export async function listAvailableMenu(establishmentId: string): Promise<AvailableMenuCategory[]> {
  const [products, categories] = await Promise.all([listMenuProducts(establishmentId), listMenuCategories(establishmentId)]);
  const active = products.filter((p) => p.active);
  return categories
    .filter((c) => c.active !== false)
    .map((c) => ({ id: c.id, name: c.name, products: active.filter((p) => p.categoryId === c.id) }))
    .filter((c) => c.products.length > 0);
}
export async function getAvailableMenuProduct(establishmentId: string, productId: string): Promise<MenuProduct | null> {
  const product = await getMenuProduct(establishmentId, productId);
  if (!product?.active) return null;
  return categoryBlocksSale(await getMenuCategory(establishmentId, product.categoryId)) ? null : product;
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
    const name = text(g?.name, 100); if (!name || !options.length) return [];
    const required = Boolean(g?.required);
    const max = Number.isInteger(g?.maxSelections) ? Math.max(0, Number(g.maxSelections)) : options.length;
    const min = Number.isInteger(g?.minSelections) ? Math.max(0, Number(g.minSelections)) : (required ? 1 : 0);
    if (required && min < 1) throw new Error(`Grupo obrigatório ${name} precisa de no mínimo uma seleção.`);
    if (min > max) throw new Error(`Mínimo de seleções não pode ser maior que o máximo em ${name}.`);
    return [{ id: text(g?.id, 80) || `group-${groupIndex + 1}`, name, required, minSelections: min, maxSelections: max, options }];
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
    const minimum = group.required ? Math.max(1, group.minSelections) : group.minSelections;
    if (selected.length < minimum || selected.length > group.maxSelections) throw new Error(`Seleção inválida em ${group.name}.`);
    modifiers.push(...selected.map((o) => ({ optionId: o.id, name: o.name, priceDeltaCents: o.priceDeltaCents })));
  }
  const unknown = unique.filter((id) => !modifiers.some((m) => m.optionId === id)); if (unknown.length) throw new Error("Adicional indisponível.");
  const unitPriceCents = product.basePriceCents + (variant?.priceDeltaCents ?? 0) + modifiers.reduce((sum, m) => sum + m.priceDeltaCents, 0);
  return { id: "", productId: product.id, productName: product.name, variantId: variant?.id ?? null, variantName: variant?.name ?? null, quantity, unitPriceCents, modifiers, notes: text(notes, 300) || null, lineTotalCents: unitPriceCents * quantity };
}
// Bairro dito no WhatsApp quase nunca vem escrito igual ao cadastro
// ("jardim america" x "Jardim América", espaço duplo, caixa alta). Sem
// normalizar acento e espaçamento, a regra do bairro não casava e a taxa
// caía silenciosamente na regra fixa — cobrança errada sem erro, sem log e
// sem aviso ao cliente ou ao painel.
const neighborhoodKey = (value: unknown) =>
  text(value, 80)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("pt-BR");

export function deliveryFee(settings: OrderSettings, fulfillment: FoodOrder["fulfillment"], neighborhood?: string | null): number {
  if (fulfillment !== "delivery") return 0;
  if (!settings.deliveryEnabled) throw new Error("Entrega não está disponível.");
  const key = neighborhoodKey(neighborhood);
  const rule = settings.deliveryRules.find((r) => r.kind === "neighborhood" && neighborhoodKey(r.neighborhood) === key) ?? settings.deliveryRules.find((r) => r.kind === "fixed");
  if (!rule) throw new Error("Não há taxa configurada para esse endereço."); return rule.feeCents;
}
function recalculate(order: FoodOrder, settings: OrderSettings): FoodOrder {
  const subtotalCents = order.items.reduce((sum, item) => sum + item.lineTotalCents, 0); const deliveryFeeCents = deliveryFee(settings, order.fulfillment, order.deliveryAddress?.neighborhood);
  const discountCents = Math.max(0, order.discountCents ?? 0);
  return { ...order, subtotalCents, discountCents, deliveryFeeCents, totalCents: subtotalCents + deliveryFeeCents - discountCents };
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
    const order: FoodOrder = { id: ref.id, establishmentId, conversationId, contactPhone: normalizePhone(contactPhone), contactName, status: "draft", fulfillment: null, deliveryAddress: null, deliveryFeeCents: 0, discountCents: 0, payment: { method: null, status: "unpaid", changeForCents: null }, items: [], subtotalCents: 0, totalCents: 0, version: 1, confirmationRequestedAt: null, snapshot: null, createdAt: now, updatedAt: now, confirmedAt: null };
    tx.set(ref, order); tx.set(conversationRef, { activeOrderId: ref.id }, { merge: true }); return order;
  });
}
async function mutateDraft(establishmentId: string, conversationId: string, contactPhone: string, contactName: string | null, operationId: string | undefined, mutation: (order: FoodOrder, settings: OrderSettings) => Promise<FoodOrder> | FoodOrder, allowCreateAfterConfirmation = false): Promise<FoodOrder> {
  const draft = await draftFor(establishmentId, conversationId, contactPhone, contactName, operationId, allowCreateAfterConfirmation); const ref = orderRef(establishmentId, draft.id); const settings = await getOrderSettings(establishmentId);
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new Error("Pedido não encontrado."); const current = snap.data() as FoodOrder; if (operationId && current.appliedOperationIds?.includes(operationId)) return current; if (!ACTIVE_DRAFT.has(current.status)) throw new Error("Este pedido não pode mais ser alterado."); const changed = await mutation(current, settings); const updated = { ...recalculate(changed, settings), status: "draft" as const, confirmationRequestedAt: null, version: current.version + 1, appliedOperationIds: operationId ? [...(current.appliedOperationIds ?? []).slice(-49), operationId] : current.appliedOperationIds, updatedAt: Date.now() }; tx.set(ref, updated); return updated; });
}
export async function addOrderItem(establishmentId: string, conversationId: string, phone: string, name: string | null, productId: string, variantId: string | null, modifierOptionIds: string[], quantity: number, notes?: string | null, operationId?: string, allowCreateAfterConfirmation = false) {
  const product = await getMenuProduct(establishmentId, productId); if (!product) throw new Error("Produto não encontrado.");
  if (categoryBlocksSale(await getMenuCategory(establishmentId, product.categoryId))) throw new Error("Produto indisponível.");
  const item = calculateItem(product, variantId, modifierOptionIds, quantity, notes); item.id = sub(establishmentId, "orders").doc().id;
  return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => ({ ...order, items: [...order.items, item] }), allowCreateAfterConfirmation);
}
// Trocar tamanho ou adicional de um item que já está no carrinho.
//
// Antes, `update_order_item` só mexia em quantidade e observação: "troca a
// pizza pra grande" ou "tira a cebola do que já pedi" exigia que o modelo
// decidisse sozinho decompor em remove + add, sem rede de segurança. Agora a
// troca é uma operação só — e o preço NUNCA vem do modelo: a composição nova
// é recalculada por `calculateItem` a partir do produto real, com as mesmas
// travas de disponibilidade, variação e grupo obrigatório da montagem.
export interface UpdateOrderItemInput {
  quantity?: number;
  notes?: string | null;
  // `undefined` = não mexe; `null` = remove a variação escolhida.
  variantId?: string | null;
  modifierOptionIds?: string[];
}
export async function updateOrderItem(establishmentId: string, conversationId: string, phone: string, name: string | null, itemId: string, input: UpdateOrderItemInput, operationId?: string) {
  const changesComposition = input.variantId !== undefined || input.modifierOptionIds !== undefined;
  let recomposed: OrderItem | null = null;
  if (changesComposition) {
    // Produto lido fora da transação, igual faz addOrderItem: o que entra na
    // transação já é um item calculado pelo backend.
    const current = await getActiveOrder(establishmentId, conversationId);
    const item = current?.items.find((i) => i.id === itemId);
    if (!item) throw new Error("Item não encontrado.");
    const product = await getMenuProduct(establishmentId, item.productId);
    if (!product) throw new Error("Produto não encontrado.");
    if (categoryBlocksSale(await getMenuCategory(establishmentId, product.categoryId))) throw new Error("Produto indisponível.");
    recomposed = calculateItem(
      product,
      input.variantId === undefined ? item.variantId : input.variantId,
      input.modifierOptionIds === undefined ? item.modifiers.map((m) => m.optionId) : input.modifierOptionIds,
      input.quantity ?? item.quantity,
      input.notes === undefined ? item.notes : input.notes,
    );
    recomposed.id = item.id;
  }
  return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => {
    const item = order.items.find((i) => i.id === itemId); if (!item) throw new Error("Item não encontrado.");
    if (recomposed) {
      // O item pode ter mudado entre a leitura do produto e a transação.
      if (recomposed.productId !== item.productId) throw new Error("Item não encontrado.");
      return { ...order, items: order.items.map((i) => i.id === itemId ? recomposed! : i) };
    }
    const quantity = input.quantity ?? item.quantity; if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("Quantidade inválida."); const next = { ...item, quantity, notes: input.notes === undefined ? item.notes : text(input.notes, 300) || null, lineTotalCents: item.unitPriceCents * quantity }; return { ...order, items: order.items.map((i) => i.id === itemId ? next : i) };
  });
}
export async function removeOrderItem(establishmentId: string, conversationId: string, phone: string, name: string | null, itemId: string, operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => order.items.some((i) => i.id === itemId) ? { ...order, items: order.items.filter((i) => i.id !== itemId) } : (() => { throw new Error("Item não encontrado."); })()); }
export async function setOrderFulfillment(establishmentId: string, conversationId: string, phone: string, name: string | null, fulfillment: "pickup" | "delivery", operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order, settings) => { if (fulfillment === "pickup" && !settings.pickupEnabled) throw new Error("Retirada não está disponível."); if (fulfillment === "delivery" && !settings.deliveryEnabled) throw new Error("Entrega não está disponível."); return { ...order, fulfillment, deliveryAddress: fulfillment === "pickup" ? null : order.deliveryAddress }; }); }
export async function setOrderAddress(establishmentId: string, conversationId: string, phone: string, name: string | null, raw: string, neighborhood?: string | null, reference?: string | null, operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order) => { if (order.fulfillment !== "delivery") throw new Error("Escolha entrega antes de informar o endereço."); if (!text(raw, 500)) throw new Error("Endereço é obrigatório."); return { ...order, deliveryAddress: { raw: text(raw, 500), neighborhood: text(neighborhood, 80) || null, reference: text(reference, 160) || null } }; }); }
export async function setOrderPayment(establishmentId: string, conversationId: string, phone: string, name: string | null, method: OrderPaymentMethod, changeForCents?: number | null, operationId?: string) { return mutateDraft(establishmentId, conversationId, phone, name, operationId, (order, settings) => { if (!settings.acceptedPaymentMethods.includes(method)) throw new Error("Forma de pagamento não aceita."); const change = changeForCents == null ? null : cents(changeForCents); if (changeForCents != null && change === null) throw new Error("Troco inválido."); return { ...order, payment: { method, status: method === "pix" ? "pending" : "unpaid", changeForCents: change } }; }); }
export async function getOrder(establishmentId: string, orderId: string) { const snap = await orderRef(establishmentId, orderId).get(); return snap.exists ? snap.data() as FoodOrder : null; }
export async function getActiveOrder(establishmentId: string, conversationId: string) { const conv = await sub(establishmentId, "conversations").doc(conversationId).get(); const id = conv.exists ? (conv.data() as { activeOrderId?: string }).activeOrderId : undefined; return id ? getOrder(establishmentId, id) : null; }
async function refreshOrderForConfirmation(tx: FirebaseFirestore.Transaction, establishmentId: string, order: FoodOrder, settings: OrderSettings): Promise<FoodOrder> {
  if (!order.items.length || !order.fulfillment || !order.payment.method || (order.fulfillment === "delivery" && !order.deliveryAddress)) throw new Error("Faltam dados para confirmar o pedido.");
  if (order.fulfillment === "pickup" && !settings.pickupEnabled) throw new Error("Retirada não está mais disponível.");
  if (order.fulfillment === "delivery" && !settings.deliveryEnabled) throw new Error("Entrega não está mais disponível.");
  if (!settings.acceptedPaymentMethods.includes(order.payment.method)) throw new Error("Forma de pagamento não aceita.");
  const refreshedItems: OrderItem[] = [];
  for (const item of order.items) {
    const productSnap = await tx.get(sub(establishmentId, "menuProducts").doc(item.productId));
    if (!productSnap.exists) throw new Error(`${item.productName} não está mais disponível.`);
    const product = productSnap.data() as MenuProduct;
    const categorySnap = await tx.get(sub(establishmentId, "menuCategories").doc(product.categoryId));
    if (categoryBlocksSale(categorySnap.exists ? categorySnap.data() as MenuCategory : null)) throw new Error(`${item.productName} não está mais disponível.`);
    let current: OrderItem;
    try { current = calculateItem(product, item.variantId, item.modifiers.map((m) => m.optionId), item.quantity, item.notes); }
    catch { throw new Error(`${item.productName} mudou ou não está mais disponível.`); }
    refreshedItems.push({ ...current, id: item.id });
  }
  const recalculated = recalculate({ ...order, items: refreshedItems }, settings);
  if (recalculated.discountCents > recalculated.subtotalCents + recalculated.deliveryFeeCents) throw new Error("Desconto inválido.");
  return recalculated;
}

// Produz o único resumo que pode ser confirmado. A mudança de estado e a
// versão são persistidas: qualquer alteração posterior volta o pedido a draft
// e obriga uma nova apresentação antes de fechar.
export async function prepareOrderConfirmation(establishmentId: string, conversationId: string, phone: string, operationId?: string): Promise<FoodOrder> {
  const settings = await getOrderSettings(establishmentId);
  const conversationRef = sub(establishmentId, "conversations").doc(conversationId);
  return db.runTransaction(async (tx) => {
    const conversation = await tx.get(conversationRef);
    const orderId = conversation.exists ? (conversation.data() as { activeOrderId?: string }).activeOrderId : undefined;
    if (!orderId) throw new Error("Não há pedido em aberto para resumir.");
    const ref = orderRef(establishmentId, orderId); const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Pedido não encontrado.");
    const current = snap.data() as FoodOrder;
    if (normalizePhone(current.contactPhone) !== normalizePhone(phone)) throw new Error("Pedido não pertence a este cliente.");
    if (operationId && current.appliedOperationIds?.includes(operationId)) return current;
    if (!ACTIVE_DRAFT.has(current.status)) throw new Error("Este pedido não pode mais ser confirmado.");
    const refreshed = await refreshOrderForConfirmation(tx, establishmentId, current, settings);
    if (current.status === "awaiting_confirmation") return current;
    const now = Date.now();
    const prepared: FoodOrder = { ...refreshed, status: "awaiting_confirmation", confirmationRequestedAt: now, version: current.version + 1, appliedOperationIds: operationId ? [...(current.appliedOperationIds ?? []).slice(-49), operationId] : current.appliedOperationIds, updatedAt: now };
    tx.set(ref, prepared); return prepared;
  });
}

export async function confirmOrder(establishmentId: string, orderId: string, expectedVersion: number, phone: string, operationId?: string): Promise<FoodOrder> {
  const ref = orderRef(establishmentId, orderId); const settings = await getOrderSettings(establishmentId);
  return db.runTransaction(async (tx) => { const snap = await tx.get(ref); if (!snap.exists) throw new Error("Pedido não encontrado."); const order = snap.data() as FoodOrder; if (normalizePhone(order.contactPhone) !== normalizePhone(phone)) throw new Error("Pedido não pertence a este cliente."); if (order.status === "confirmed") return order; if (order.status !== "awaiting_confirmation" || order.version !== expectedVersion) throw new Error("O pedido mudou; confira o resumo atualizado antes de confirmar.");
    const refreshed = await refreshOrderForConfirmation(tx, establishmentId, order, settings);
    for (let index = 0; index < order.items.length; index++) {
      const before = order.items[index]; const current = refreshed.items[index];
      if (!current || current.unitPriceCents !== before.unitPriceCents || current.lineTotalCents !== before.lineTotalCents || current.productName !== before.productName) throw new Error(`${before.productName} mudou de preço; confira o resumo atualizado antes de confirmar.`);
    }
    if (refreshed.subtotalCents !== order.subtotalCents || refreshed.deliveryFeeCents !== order.deliveryFeeCents || refreshed.discountCents !== order.discountCents || refreshed.totalCents !== order.totalCents) throw new Error("O total mudou; confira o resumo atualizado antes de confirmar.");
    const now = Date.now(); const snapshot = { items: refreshed.items, subtotalCents: refreshed.subtotalCents, discountCents: refreshed.discountCents, deliveryFeeCents: refreshed.deliveryFeeCents, totalCents: refreshed.totalCents, fulfillment: refreshed.fulfillment!, deliveryAddress: refreshed.deliveryAddress, payment: refreshed.payment as NonNullable<FoodOrder["snapshot"]>["payment"], createdAt: now }; const confirmed: FoodOrder = { ...refreshed, status: "confirmed", snapshot, version: order.version + 1, appliedOperationIds: operationId ? [...(order.appliedOperationIds ?? []).slice(-49), operationId] : order.appliedOperationIds, operationalHistory: [...(order.operationalHistory ?? []), { from: "awaiting_confirmation", to: "confirmed", at: now, source: "customer_confirmation" }], confirmedAt: now, updatedAt: now }; tx.set(ref, confirmed); tx.set(sub(establishmentId, "conversations").doc(order.conversationId), { activeOrderId: null, lastConfirmedOrderId: order.id }, { merge: true }); return confirmed;
  });
}

export type OrderOperationErrorCode = "not_found" | "stale_version" | "invalid_transition";
export class OrderOperationError extends Error {
  constructor(public readonly code: OrderOperationErrorCode, message: string) { super(message); this.name = "OrderOperationError"; }
}

export function allowedOrderTransitions(order: Pick<FoodOrder, "status" | "fulfillment">): OrderStatus[] {
  if (TERMINAL.has(order.status) || ACTIVE_DRAFT.has(order.status)) return [];
  if (order.status === "confirmed") return ["accepted", "cancelled"];
  if (order.status === "accepted") return ["preparing", "cancelled"];
  if (order.status === "preparing") return ["ready_for_pickup", "cancelled"];
  if (order.status === "ready_for_pickup") return order.fulfillment === "delivery" ? ["out_for_delivery", "cancelled"] : order.fulfillment === "pickup" ? ["completed", "cancelled"] : [];
  if (order.status === "out_for_delivery") return order.fulfillment === "delivery" ? ["completed", "cancelled"] : [];
  return [];
}

export function isOperationalOrder(order: Pick<FoodOrder, "status">): boolean { return OPERATIONAL.has(order.status); }

export async function transitionOrder(establishmentId: string, orderId: string, status: OrderStatus, expectedVersion: number): Promise<FoodOrder> {
  const ref = orderRef(establishmentId, orderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new OrderOperationError("not_found", "Pedido não encontrado.");
    const order = snap.data() as FoodOrder;
    // Retry técnico da mesma intenção: a primeira chamada já venceu. Não cria
    // histórico nem incrementa versão novamente.
    if (order.status === status) {
      if (!isOperationalOrder(order)) throw new OrderOperationError("invalid_transition", "Carrinhos ainda não confirmados não aceitam transições operacionais.");
      return order;
    }
    if (!Number.isInteger(expectedVersion) || order.version !== expectedVersion) throw new OrderOperationError("stale_version", "O pedido foi atualizado por outro operador. Atualize a tela e tente novamente.");
    if (!allowedOrderTransitions(order).includes(status)) throw new OrderOperationError("invalid_transition", "Transição de status inválida para este pedido.");
    const now = Date.now();
    const next: FoodOrder = { ...order, status, operationalHistory: [...(order.operationalHistory ?? []), { from: order.status, to: status, at: now, source: "panel" }], updatedAt: now, version: order.version + 1 };
    tx.set(ref, next);
    return next;
  });
}

export async function listOrders(establishmentId: string): Promise<FoodOrder[]> {
  // Filtrar depois de um limit global permite que muitos drafts recentes
  // escondam pedidos ativos mais antigos. Consulta cada estado operacional
  // diretamente: carrinhos nunca disputam a janela da fila do restaurante.
  const snapshots = await Promise.all([...OPERATIONAL].map((status) => sub(establishmentId, "orders").where("status", "==", status).limit(200).get()));
  return snapshots
    .flatMap((snap) => snap.docs.map((d) => d.data() as FoodOrder))
    .sort((a, b) => {
      const aPriority = ACTIVE_OPERATION_PRIORITY[a.status]; const bPriority = ACTIVE_OPERATION_PRIORITY[b.status];
      if (aPriority !== undefined && bPriority === undefined) return -1;
      if (aPriority === undefined && bPriority !== undefined) return 1;
      if (aPriority !== undefined && bPriority !== undefined) return aPriority - bPriority || a.createdAt - b.createdAt;
      return b.updatedAt - a.updatedAt;
    });
}
