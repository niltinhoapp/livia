"use client";
import { useCallback, useEffect, useState } from "react";
import type { FoodOrder, MenuCategory, MenuModifierGroup, MenuModifierOption, MenuProduct, MenuVariant, OrderStatus } from "@/types";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label, Select } from "@/components/ui/Field";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge, type StatusTone } from "@/components/ui/StatusBadge";
import { Toggle } from "@/components/ui/Toggle";
import { OrderSettingsEditor } from "./OrderSettingsEditor";

const money = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const labels: Record<OrderStatus, { label: string; tone: StatusTone }> = { draft: { label: "Rascunho", tone: "neutral" }, awaiting_confirmation: { label: "Aguardando confirmação", tone: "warning" }, confirmed: { label: "Novo", tone: "warning" }, accepted: { label: "Aceito", tone: "info" }, preparing: { label: "Preparando", tone: "info" }, ready_for_pickup: { label: "Pronto para retirada", tone: "success" }, out_for_delivery: { label: "Saiu para entrega", tone: "info" }, completed: { label: "Concluído", tone: "success" }, cancelled: { label: "Cancelado", tone: "danger" }, rejected: { label: "Recusado", tone: "danger" } };
const next: Partial<Record<OrderStatus, { status: OrderStatus; label: string }[]>> = { confirmed: [{ status: "accepted", label: "Aceitar" }, { status: "rejected", label: "Recusar" }], accepted: [{ status: "preparing", label: "Preparar" }], preparing: [{ status: "ready_for_pickup", label: "Pronto para retirada" }, { status: "out_for_delivery", label: "Saiu para entrega" }], ready_for_pickup: [{ status: "completed", label: "Concluir" }], out_for_delivery: [{ status: "completed", label: "Concluir" }] };

// Preço em centavos <-> texto "19,90" pro input. Centralizado aqui porque
// aparece em produto, variante e opção de adicional.
function parseReais(raw: string): number | null {
  const cents = Math.round(Number(raw.replace(",", ".")) * 100);
  return Number.isFinite(cents) ? cents : null;
}
function reaisText(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

export default function PedidosPage() {
  const [orders, setOrders] = useState<FoodOrder[]>([]); const [categories, setCategories] = useState<MenuCategory[]>([]); const [products, setProducts] = useState<MenuProduct[]>([]); const [ordersEnabled, setOrdersEnabled] = useState(true); const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Com a IA de pedidos desligada, a tela continua inteira: o comerciante
  // ainda precisa tocar os pedidos em andamento e mexer no cardápio. O que
  // muda é só o aviso no topo.
  const load = useCallback(async () => { setState("loading"); const [o, c, p] = await Promise.all([fetch("/api/orders"), fetch("/api/menu/categories"), fetch("/api/menu/products")]); if (!o.ok || !c.ok || !p.ok) { setState("error"); return; } const [oj, cj, pj] = await Promise.all([o.json(), c.json(), p.json()]); setOrders(oj.orders ?? []); setOrdersEnabled(oj.ordersEnabled !== false); setCategories(cj.categories ?? []); setProducts(pj.products ?? []); setState("ready"); }, []);
  useEffect(() => { load(); }, [load]);
  const transition = async (id: string, status: OrderStatus) => { const r = await fetch(`/api/orders/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); if (r.ok) load(); };
  if (state === "loading") return <LoadingState />;
  if (state === "error") return <ErrorState onRetry={load} />;
  return <div className="mx-auto max-w-5xl"><PageHeader title="Pedidos" description="Acompanhe novos pedidos e mantenha o cliente informado pela conversa." action={<Button variant="secondary" size="sm" onClick={load}>Atualizar</Button>} />
    {!ordersEnabled && <Card className="mb-4 p-4"><p className="font-semibold">A Livia não está aceitando pedidos novos</p><p className="mt-1 text-sm text-ink-500">Ative “Permitir pedidos pela IA” em Configurações para voltar a receber pedidos pelo WhatsApp. Os pedidos já feitos continuam aqui e podem ser tocados normalmente.</p></Card>}
    <section className="grid gap-4 lg:grid-cols-2"><div><h2 className="mb-3 text-lg font-bold">Fila de pedidos</h2>{orders.filter((o) => o.status !== "draft").length === 0 ? <EmptyState title="Nenhum pedido confirmado" description="Pedidos confirmados pelo WhatsApp aparecem aqui." /> : <div className="space-y-3">{orders.filter((o) => o.status !== "draft").map((o) => <Card key={o.id} className="p-4"><div className="flex justify-between gap-3"><div><p className="font-semibold">{o.contactName ?? o.contactPhone}</p><p className="text-xs text-ink-500">{o.fulfillment === "delivery" ? `Entrega: ${o.deliveryAddress?.raw ?? "endereço pendente"}` : "Retirada"} · {o.payment.method ?? "pagamento pendente"}</p></div><StatusBadge tone={labels[o.status].tone}>{labels[o.status].label}</StatusBadge></div><ul className="mt-3 text-sm text-ink-700">{o.items.map((i) => <li key={i.id}>{i.quantity}× {i.productName}{i.variantName ? ` · ${i.variantName}` : ""}{i.notes ? ` (${i.notes})` : ""}</li>)}</ul><p className="mt-3 font-bold">Total: {money(o.totalCents)}</p><div className="mt-3 flex flex-wrap gap-2">{next[o.status]?.map((n) => <Button key={n.status} size="sm" onClick={() => transition(o.id, n.status)}>{n.label}</Button>)}{["confirmed", "accepted", "preparing", "ready_for_pickup", "out_for_delivery"].includes(o.status) && <Button size="sm" variant="danger" onClick={() => transition(o.id, "cancelled")}>Cancelar</Button>}</div></Card>)}</div>}</div>
    <div><h2 className="mb-3 text-lg font-bold">Cardápio</h2><MenuEditor categories={categories} products={products} onChanged={load} /></div></section>
    <section className="mt-6"><h2 className="mb-3 text-lg font-bold">Operação</h2><OrderSettingsEditor /></section></div>;
}

function MenuEditor({ categories, products, onChanged }: { categories: MenuCategory[]; products: MenuProduct[]; onChanged: () => void }) {
  const [category, setCategory] = useState(""); const [name, setName] = useState(""); const [productCategory, setProductCategory] = useState(""); const [price, setPrice] = useState(""); const [saving, setSaving] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const addCategory = async () => { if (!category.trim()) return; setSaving(true); await fetch("/api/menu/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: category }) }); setCategory(""); setSaving(false); onChanged(); };
  const addProduct = async () => { const cents = parseReais(price); if (!name.trim() || !productCategory || cents === null || cents < 0) return; setSaving(true); await fetch("/api/menu/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, categoryId: productCategory, basePriceCents: cents, active: true, variants: [], modifierGroups: [] }) }); setName(""); setPrice(""); setSaving(false); onChanged(); };
  const toggleCategoryActive = async (c: MenuCategory) => { await fetch(`/api/menu/categories/${c.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...c, active: !c.active }) }); onChanged(); };

  return <div className="space-y-4">
    <Card className="p-4">
      <Label>Nova categoria</Label>
      <div className="mt-2 flex gap-2"><Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Ex.: Hambúrgueres" /><Button size="sm" disabled={saving} onClick={addCategory}>Adicionar</Button></div>
      {categories.length > 0 && <ul className="mt-3 space-y-1 text-sm">
        {categories.map((c) => <li key={c.id} className="flex items-center justify-between gap-2 border-t border-line/60 pt-2 first:border-t-0 first:pt-0">
          {editingCategoryId === c.id
            ? <InlineCategoryRename category={c} onDone={() => { setEditingCategoryId(null); onChanged(); }} />
            : <span className={c.active ? "" : "text-ink-400 line-through"}>{c.name}</span>}
          <div className="flex shrink-0 gap-2">
            {editingCategoryId !== c.id && <Button size="sm" variant="secondary" onClick={() => setEditingCategoryId(c.id)}>Renomear</Button>}
            <Button size="sm" variant="secondary" onClick={() => toggleCategoryActive(c)}>{c.active ? "Desativar" : "Ativar"}</Button>
          </div>
        </li>)}
      </ul>}
    </Card>

    <Card className="p-4">
      <p className="mb-3 font-semibold">Novo produto</p>
      <div className="grid gap-3">
        <div><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="X-Burguer" /></div>
        <div><Label>Categoria</Label><Select value={productCategory} onChange={(e) => setProductCategory(e.target.value)}><option value="">Selecione</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
        <div><Label>Preço (R$)</Label><Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="19,90" /></div>
        <Button disabled={saving || categories.length === 0} onClick={addProduct}>Salvar produto</Button>
        <p className="text-xs text-ink-400">Variantes e adicionais são configurados depois, clicando em &quot;Editar&quot; no produto já criado.</p>
      </div>
    </Card>

    <Card className="p-4">
      <p className="mb-2 font-semibold">Produtos cadastrados</p>
      {products.length === 0 ? <p className="text-sm text-ink-500">Cadastre categorias e produtos para começar.</p> : <ul className="space-y-2 text-sm">
        {products.map((p) => <li key={p.id} className="border-t border-line/60 pt-2 first:border-t-0 first:pt-0">
          <div className="flex items-center justify-between gap-2">
            <span className={p.active ? "" : "text-ink-400"}>{p.name}{!p.active ? " · indisponível" : ""}</span>
            <div className="flex shrink-0 items-center gap-2">
              <strong>{money(p.basePriceCents)}</strong>
              <Button size="sm" variant="secondary" onClick={() => setEditingProductId(editingProductId === p.id ? null : p.id)}>{editingProductId === p.id ? "Fechar" : "Editar"}</Button>
            </div>
          </div>
          {editingProductId === p.id && <ProductEditor product={p} categories={categories} onSaved={() => { onChanged(); setEditingProductId(null); }} onCancel={() => setEditingProductId(null)} />}
        </li>)}
      </ul>}
    </Card>
  </div>;
}

function InlineCategoryRename({ category, onDone }: { category: MenuCategory; onDone: () => void }) {
  const [value, setValue] = useState(category.name);
  const save = async () => { if (!value.trim()) return; await fetch(`/api/menu/categories/${category.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...category, name: value }) }); onDone(); };
  return <div className="flex flex-1 gap-2"><Input value={value} onChange={(e) => setValue(e.target.value)} className="h-8" /><Button size="sm" onClick={save}>Salvar</Button></div>;
}

// Linha local de variante/opção antes de salvar: `id` vazio significa "nova,
// deixa o backend atribuir" (normalizeProduct já faz isso — ver
// lib/orders.ts). `key` é só pra estabilidade de renderização do React,
// nunca enviado ao backend.
type DraftVariant = MenuVariant & { key: string };
type DraftOption = MenuModifierOption & { key: string };
type DraftGroup = Omit<MenuModifierGroup, "options"> & { key: string; options: DraftOption[] };

function newKey(): string { return `new-${Math.random().toString(36).slice(2)}`; }

// Editor completo de UM produto: nome/descrição/categoria/preço/ativo,
// variantes e grupos de adicionais (com suas opções). Salva sempre o
// PRODUTO INTEIRO via PUT — não existe sub-recurso de variante/adicional no
// backend (lib/orders.ts::saveMenuProduct só aceita o objeto completo), então
// a UI compõe o objeto inteiro e normalizeProduct valida/persiste tudo de
// uma vez. "Não precisa polimento visual fino" — funcional é o suficiente.
function ProductEditor({ product, categories, onSaved, onCancel }: { product: MenuProduct; categories: MenuCategory[]; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? "");
  const [categoryId, setCategoryId] = useState(product.categoryId);
  const [priceText, setPriceText] = useState(reaisText(product.basePriceCents));
  const [active, setActive] = useState(product.active);
  const [variants, setVariants] = useState<DraftVariant[]>(product.variants.map((v) => ({ ...v, key: v.id })));
  const [groups, setGroups] = useState<DraftGroup[]>(product.modifierGroups.map((g) => ({ ...g, key: g.id, options: g.options.map((o) => ({ ...o, key: o.id })) })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addVariant = () => setVariants((v) => [...v, { key: newKey(), id: "", name: "", priceDeltaCents: 0, active: true }]);
  const updateVariant = (key: string, patch: Partial<DraftVariant>) => setVariants((v) => v.map((x) => x.key === key ? { ...x, ...patch } : x));
  const removeVariant = (key: string) => setVariants((v) => v.filter((x) => x.key !== key));

  const addGroup = () => setGroups((g) => [...g, { key: newKey(), id: "", name: "", required: false, minSelections: 0, maxSelections: 1, options: [] }]);
  const updateGroup = (key: string, patch: Partial<Omit<DraftGroup, "options">>) => setGroups((g) => g.map((x) => x.key === key ? { ...x, ...patch } : x));
  const removeGroup = (key: string) => setGroups((g) => g.filter((x) => x.key !== key));
  const addOption = (groupKey: string) => setGroups((g) => g.map((x) => x.key === groupKey ? { ...x, options: [...x.options, { key: newKey(), id: "", name: "", priceDeltaCents: 0, active: true }] } : x));
  const updateOption = (groupKey: string, optKey: string, patch: Partial<DraftOption>) => setGroups((g) => g.map((x) => x.key === groupKey ? { ...x, options: x.options.map((o) => o.key === optKey ? { ...o, ...patch } : o) } : x));
  const removeOption = (groupKey: string, optKey: string) => setGroups((g) => g.map((x) => x.key === groupKey ? { ...x, options: x.options.filter((o) => o.key !== optKey) } : x));

  // Valida ANTES de chamar a API — sem isto, o backend não rejeita algumas
  // configurações inválidas com erro: ele as descarta ou ajusta em silêncio
  // (ver lib/orders.ts::normalizeProduct): variante/opção com priceDeltaCents
  // negativo é descartada da lista inteira sem aviso (mesma regra de
  // `cents()` do preço base, só que ali sim lança erro); grupo sem nenhuma
  // opção é descartado inteiro; minSelections > maxSelections é
  // silenciosamente reduzido pro máximo. Pegar isso aqui evita o comerciante
  // salvar e achar que configurou uma variante/grupo que na verdade sumiu.
  function validateProduct(basePriceCents: number | null): string | null {
    if (!name.trim()) return "Informe o nome do produto.";
    if (!categoryId) return "Selecione uma categoria.";
    if (basePriceCents === null || basePriceCents < 0) return "Preço base inválido.";
    for (const v of variants) {
      if (!v.name.trim()) return "Toda variante precisa de um nome.";
      if (v.priceDeltaCents < 0) return `Preço inválido na variante "${v.name}" — não pode ser negativo.`;
    }
    for (const g of groups) {
      if (!g.name.trim()) return "Todo grupo de adicionais precisa de um nome.";
      if (g.options.length === 0) return `O grupo "${g.name}" precisa de pelo menos uma opção.`;
      if (g.minSelections > g.maxSelections) return `No grupo "${g.name}", o mínimo (${g.minSelections}) não pode ser maior que o máximo (${g.maxSelections}).`;
      if (g.required && g.minSelections < 1) return `O grupo "${g.name}" está marcado como obrigatório — o mínimo precisa ser pelo menos 1.`;
      for (const o of g.options) {
        if (!o.name.trim()) return `Toda opção do grupo "${g.name}" precisa de um nome.`;
        if (o.priceDeltaCents < 0) return `Preço inválido na opção "${o.name}" (grupo "${g.name}") — não pode ser negativo.`;
      }
    }
    return null;
  }

  const save = async () => {
    const basePriceCents = parseReais(priceText);
    const validationError = validateProduct(basePriceCents);
    if (validationError) { setError(validationError); return; }
    setSaving(true); setError(null);
    const body = {
      name, description: description || null, categoryId, basePriceCents, active,
      variants: variants.map(({ key: _key, ...v }) => v),
      modifierGroups: groups.map(({ key: _key, options, ...g }) => ({ ...g, options: options.map(({ key: _optKey, ...o }) => o) })),
    };
    const res = await fetch(`/api/menu/products/${product.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    setSaving(false);
    if (!res.ok) { const j = await res.json().catch(() => ({})); setError(typeof j.error === "string" ? j.error : "Não foi possível salvar."); return; }
    onSaved();
  };

  return <Card className="mt-2 p-4">
    {error && <p className="mb-3 rounded-control border border-danger/30 bg-danger-bg/40 p-2 text-sm text-danger-fg">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2">
      <div><Label>Nome</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div><Label>Categoria</Label><Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
      <div><Label>Preço base (R$)</Label><Input value={priceText} onChange={(e) => setPriceText(e.target.value)} inputMode="decimal" /></div>
      <div className="flex items-end"><Toggle checked={active} onChange={setActive} title="Disponível" desc="Produtos indisponíveis somem da busca da IA e do painel de vendas." /></div>
      <div className="sm:col-span-2"><Label hint="opcional">Descrição</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} /></div>
    </div>

    <div className="mt-5 border-t border-line/60 pt-4">
      <div className="mb-2 flex items-center justify-between"><p className="font-semibold">Variantes</p><Button size="sm" variant="secondary" onClick={addVariant}>+ Variante</Button></div>
      {variants.length === 0 && <p className="text-xs text-ink-400">Nenhuma — use quando o produto tem tamanhos/versões com preço diferente (ex.: Pequeno/Médio/Grande).</p>}
      <div className="space-y-2">{variants.map((v) => <div key={v.key} className="flex flex-wrap items-center gap-2 rounded-control border border-line p-2">
        <Input value={v.name} onChange={(e) => updateVariant(v.key, { name: e.target.value })} placeholder="Nome (ex.: Grande)" className="w-40" />
        <Input value={reaisText(v.priceDeltaCents)} onChange={(e) => updateVariant(v.key, { priceDeltaCents: parseReais(e.target.value) ?? 0 })} inputMode="decimal" placeholder="+0,00" className="w-24" />
        <Toggle checked={v.active} onChange={(checked) => updateVariant(v.key, { active: checked })} title="Ativa" />
        <Button size="sm" variant="danger" onClick={() => removeVariant(v.key)}>Remover</Button>
      </div>)}</div>
    </div>

    <div className="mt-5 border-t border-line/60 pt-4">
      <div className="mb-2 flex items-center justify-between"><p className="font-semibold">Grupos de adicionais</p><Button size="sm" variant="secondary" onClick={addGroup}>+ Grupo</Button></div>
      {groups.length === 0 && <p className="text-xs text-ink-400">Nenhum — use pra adicionais como "Bacon", "Ponto da carne" etc.</p>}
      <div className="space-y-3">{groups.map((g) => <Card key={g.key} className="border border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={g.name} onChange={(e) => updateGroup(g.key, { name: e.target.value })} placeholder="Nome do grupo (ex.: Adicionais)" className="w-48" />
          <Toggle checked={g.required} onChange={(checked) => updateGroup(g.key, { required: checked, minSelections: checked ? Math.max(1, g.minSelections) : g.minSelections })} title="Obrigatório" />
          <label className="flex items-center gap-1 text-xs text-ink-500">Mín. <Input value={String(g.minSelections)} onChange={(e) => updateGroup(g.key, { minSelections: Math.max(g.required ? 1 : 0, Number(e.target.value) || 0) })} inputMode="numeric" className="w-14" /></label>
          <label className="flex items-center gap-1 text-xs text-ink-500">Máx. <Input value={String(g.maxSelections)} onChange={(e) => updateGroup(g.key, { maxSelections: Math.max(0, Number(e.target.value) || 0) })} inputMode="numeric" className="w-14" /></label>
          <Button size="sm" variant="danger" onClick={() => removeGroup(g.key)}>Remover grupo</Button>
        </div>
        <div className="mt-2 space-y-2 pl-2">
          {g.options.map((o) => <div key={o.key} className="flex flex-wrap items-center gap-2">
            <Input value={o.name} onChange={(e) => updateOption(g.key, o.key, { name: e.target.value })} placeholder="Opção (ex.: Bacon extra)" className="w-40" />
            <Input value={reaisText(o.priceDeltaCents)} onChange={(e) => updateOption(g.key, o.key, { priceDeltaCents: parseReais(e.target.value) ?? 0 })} inputMode="decimal" placeholder="+0,00" className="w-24" />
            <Toggle checked={o.active} onChange={(checked) => updateOption(g.key, o.key, { active: checked })} title="Ativa" />
            <Button size="sm" variant="danger" onClick={() => removeOption(g.key, o.key)}>Remover</Button>
          </div>)}
          <Button size="sm" variant="secondary" onClick={() => addOption(g.key)}>+ Opção</Button>
        </div>
      </Card>)}</div>
    </div>

    <div className="mt-5 flex gap-2 border-t border-line/60 pt-4">
      <Button disabled={saving} onClick={save}>{saving ? "Salvando…" : "Salvar produto"}</Button>
      <Button variant="secondary" disabled={saving} onClick={onCancel}>Cancelar</Button>
    </div>
  </Card>;
}
