"use client";
// F2 da Lívia Alimentação V2 — tela de configuração de pedido.
//
// A API (`/api/orders/settings`) já existia desde o MVP do Codex, mas nenhuma
// tela a consumia: o estabelecimento ficava preso no padrão (só retirada,
// entrega desligada, taxa R$ 0, todos os métodos aceitos, sem chave PIX) e só
// dava pra mudar chamando a API na mão. Esta tela é a interface que faltava —
// nenhuma regra nova de domínio, nenhuma mudança de contrato.
//
// A validação aqui é de FORMULÁRIO (não deixar o comerciante salvar algo que
// trava a própria operação). Quem valida o dado de verdade continua sendo
// `normalizeOrderSettings` no backend.
import { useCallback, useEffect, useState } from "react";
import type { DayHours, DeliveryFeeRule, OrderHoursConfig, OrderNotificationEvent, OrderPaymentMethod, OrderSettings, ScheduleConfig } from "@/types";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input, Label, Textarea } from "@/components/ui/Field";
import { Toggle } from "@/components/ui/Toggle";

const PAYMENT_LABELS: Record<OrderPaymentMethod, string> = {
  pix: "PIX",
  cash: "Dinheiro",
  credit_card: "Cartão de crédito",
  debit_card: "Cartão de débito",
};
const PAYMENT_ORDER: OrderPaymentMethod[] = ["pix", "cash", "credit_card", "debit_card"];
const NOTIFICATION_EVENTS: Array<{ event: OrderNotificationEvent; label: string }> = [
  { event: "accepted", label: "Pedido aceito" },
  { event: "ready_for_pickup", label: "Pronto para retirada" },
  { event: "out_for_delivery", label: "Saiu para entrega" },
  { event: "cancelled", label: "Pedido cancelado" },
];

// Mesma conversão usada no editor de cardápio: centavos <-> "19,90".
function parseReais(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cents = Math.round(Number(trimmed.replace(",", ".")) * 100);
  return Number.isInteger(cents) && cents >= 0 ? cents : null;
}
function reaisText(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

interface NeighborhoodDraft {
  key: string;
  name: string;
  feeText: string;
}
interface Draft {
  pickupEnabled: boolean;
  deliveryEnabled: boolean;
  // Regra `fixed` é o fallback do backend para bairro não listado. Deixar de
  // enviá-la é uma escolha legítima: aí a Livia recusa endereço fora da lista
  // em vez de chutar uma taxa.
  fallbackEnabled: boolean;
  fallbackFeeText: string;
  neighborhoods: NeighborhoodDraft[];
  methods: OrderPaymentMethod[];
  pixInstructions: string;
  notificationTemplates: Record<OrderNotificationEvent, { templateName: string; languageCode: string }>;
  orderHours: OrderHoursConfig | null;
}

let neighborhoodSeq = 0;
const nextKey = () => `n-${++neighborhoodSeq}`;

export function toDraft(settings: OrderSettings): Draft {
  const fallback = settings.deliveryRules.find((r) => r.kind === "fixed");
  return {
    pickupEnabled: settings.pickupEnabled,
    deliveryEnabled: settings.deliveryEnabled,
    fallbackEnabled: Boolean(fallback),
    fallbackFeeText: fallback ? reaisText(fallback.feeCents) : "0,00",
    neighborhoods: settings.deliveryRules
      .filter((r): r is Extract<DeliveryFeeRule, { kind: "neighborhood" }> => r.kind === "neighborhood")
      .map((r) => ({ key: nextKey(), name: r.neighborhood, feeText: reaisText(r.feeCents) })),
    methods: settings.acceptedPaymentMethods,
    pixInstructions: settings.pixInstructions ?? "",
    notificationTemplates: Object.fromEntries(NOTIFICATION_EVENTS.map(({ event }) => [event, {
      templateName: settings.notificationTemplates?.[event]?.templateName ?? "",
      languageCode: settings.notificationTemplates?.[event]?.languageCode ?? "pt_BR",
    }])) as Draft["notificationTemplates"],
    orderHours: settings.orderHours ?? null,
  };
}

// Erro de formulário: o que impediria a operação de funcionar depois de
// salvo. Devolve null quando está tudo certo.
export function validateDraft(draft: Draft): string | null {
  if (!draft.pickupEnabled && !draft.deliveryEnabled) {
    return "Escolha pelo menos uma opção: retirada ou entrega. Sem nenhuma das duas, a Livia não consegue fechar pedido.";
  }
  if (!draft.methods.length) {
    return "Escolha pelo menos uma forma de pagamento aceita.";
  }
  if (draft.deliveryEnabled) {
    if (draft.fallbackEnabled && parseReais(draft.fallbackFeeText) === null) {
      return "Taxa padrão de entrega inválida. Use um valor como 8,00.";
    }
    for (const n of draft.neighborhoods) {
      if (!n.name.trim()) return "Todo bairro precisa de nome.";
      if (parseReais(n.feeText) === null) return `Taxa inválida no bairro ${n.name.trim()}. Use um valor como 8,00.`;
    }
    if (!draft.fallbackEnabled && !draft.neighborhoods.length) {
      return "Com entrega ligada, cadastre a taxa padrão ou pelo menos um bairro.";
    }
  }
  for (const { event, label } of NOTIFICATION_EVENTS) {
    const configured = draft.notificationTemplates[event];
    if (!configured.templateName.trim()) continue;
    if (!/^[a-z0-9_]+$/.test(configured.templateName.trim())) return `Nome de template inválido em ${label}.`;
    if (!/^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/.test(configured.languageCode.trim())) return `Idioma de template inválido em ${label}.`;
  }
  return null;
}

export function toSettings(draft: Draft): OrderSettings {
  const rules: DeliveryFeeRule[] = draft.neighborhoods
    .filter((n) => n.name.trim())
    .map((n) => ({ kind: "neighborhood" as const, neighborhood: n.name.trim(), feeCents: parseReais(n.feeText) ?? 0 }));
  if (draft.fallbackEnabled) rules.push({ kind: "fixed", feeCents: parseReais(draft.fallbackFeeText) ?? 0 });
  return {
    pickupEnabled: draft.pickupEnabled,
    deliveryEnabled: draft.deliveryEnabled,
    deliveryRules: rules,
    acceptedPaymentMethods: draft.methods,
    pixInstructions: draft.pixInstructions.trim() || null,
    notificationTemplates: Object.fromEntries(NOTIFICATION_EVENTS.flatMap(({ event }) => {
      const configured = draft.notificationTemplates[event];
      return configured.templateName.trim() ? [[event, { templateName: configured.templateName.trim(), languageCode: configured.languageCode.trim() }]] : [];
    })),
    orderHours: draft.orderHours,
  };
}

const WEEKDAYS: Array<{ key: string; label: string }> = [
  { key: "0", label: "Domingo" }, { key: "1", label: "Segunda" }, { key: "2", label: "Terça" }, { key: "3", label: "Quarta" }, { key: "4", label: "Quinta" }, { key: "5", label: "Sexta" }, { key: "6", label: "Sábado" },
];
function copyBusinessHours(schedule: ScheduleConfig | null): OrderHoursConfig {
  const days: Record<string, DayHours | null> = {};
  for (const { key } of WEEKDAYS) {
    const day = schedule?.days[key] ?? null;
    // A janela específica representa somente recebimento de pedidos. Pausas
    // continuam sendo herdadas exclusivamente quando o comerciante escolhe
    // usar o expediente geral — não criamos pausas invisíveis nesta tela.
    days[key] = day ? { open: day.open, close: day.close } : null;
  }
  return { days };
}

export function OrderSettingsEditor() {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    const response = await fetch("/api/orders/settings");
    if (!response.ok) { setState("error"); return; }
    const body = await response.json() as { settings: OrderSettings; schedule?: ScheduleConfig };
    setDraft(toDraft(body.settings));
    setSchedule(body.schedule ?? null);
    setState("ready");
  }, []);
  useEffect(() => { load(); }, [load]);

  const patch = (change: Partial<Draft>) => {
    setSaved(false);
    setDraft((current) => current ? { ...current, ...change } : current);
  };
  const toggleMethod = (method: OrderPaymentMethod) => {
    if (!draft) return;
    patch({ methods: draft.methods.includes(method) ? draft.methods.filter((m) => m !== method) : [...draft.methods, method] });
  };
  const save = async () => {
    if (!draft) return;
    const problem = validateDraft(draft);
    if (problem) { setError(problem); setSaved(false); return; }
    setError(null); setSaving(true);
    const response = await fetch("/api/orders/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(toSettings(draft)),
    });
    setSaving(false);
    if (!response.ok) { setError("Não foi possível salvar. Tente de novo."); return; }
    const body = await response.json() as { settings: OrderSettings; schedule?: ScheduleConfig };
    setDraft(toDraft(body.settings));
    setSaved(true);
  };

  if (state === "loading") return <Card className="p-4"><p className="text-sm text-ink-500">Carregando configurações…</p></Card>;
  if (state === "error" || !draft) return <Card className="p-4"><p className="text-sm text-ink-500">Não foi possível carregar as configurações de pedido.</p><Button className="mt-3" size="sm" variant="secondary" onClick={load}>Tentar de novo</Button></Card>;

  return <Card className="p-4">
    <p className="font-semibold">Configurações de pedido</p>
    <p className="mt-1 text-sm text-ink-500">Define o que a Livia pode oferecer ao cliente durante o pedido.</p>

    <div className="mt-4">
      <Toggle checked={draft.pickupEnabled} onChange={(v) => patch({ pickupEnabled: v })} title="Retirada no balcão" desc="O cliente busca o pedido no local." />
      <Toggle checked={draft.deliveryEnabled} onChange={(v) => patch({ deliveryEnabled: v })} title="Entrega" desc="A Livia pede o endereço e o backend calcula a taxa." />
    </div>

    <div className="mt-4 border-t border-line/60 pt-4">
      <p className="text-sm font-semibold text-ink-700">Horário para receber pedidos</p>
      <p className="mt-1 text-xs text-ink-400">Por padrão, a Lívia usa o horário de funcionamento cadastrado em Configurações. Você pode limitar somente o recebimento de pedidos sem alterar a agenda.</p>
      <Toggle
        checked={draft.orderHours === null}
        onChange={(same) => patch({ orderHours: same ? null : copyBusinessHours(schedule) })}
        title="Usar horário de funcionamento"
        desc={draft.orderHours === null ? "Pedidos seguem o expediente geral, incluindo pausas." : "Ative para voltar a herdar o expediente geral."}
      />
      {draft.orderHours && <div className="mt-3 divide-y divide-line rounded-control border border-line px-3">
        <p className="py-3 text-xs text-ink-400">Janelas que atravessam a meia-noite são aceitas: por exemplo, 18:00 até 01:00.</p>
        {WEEKDAYS.map(({ key, label }) => {
          const day = draft.orderHours!.days[key];
          const setDay = (next: DayHours | null) => patch({ orderHours: { days: { ...draft.orderHours!.days, [key]: next } } });
          return <div key={key} className="py-2.5">
            <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={Boolean(day)} onChange={(event) => setDay(event.target.checked ? { open: "09:00", close: "18:00" } : null)} className="h-4 w-4 accent-primary" /><span className="text-sm font-medium">{label}</span></label>
            {day ? <div className="mt-2 flex items-center gap-2 pl-6"><Input type="time" className="w-auto" value={day.open} onChange={(event) => setDay({ ...day, open: event.target.value })} /><span className="text-ink-400">às</span><Input type="time" className="w-auto" value={day.close} onChange={(event) => setDay({ ...day, close: event.target.value })} /></div> : <span className="mt-1 block pl-6 text-xs text-ink-400">Não recebe pedidos</span>}
          </div>;
        })}
      </div>}
    </div>

    {draft.deliveryEnabled && <div className="mt-4 border-t border-line/60 pt-4">
      <p className="mb-2 text-sm font-semibold text-ink-700">Taxa de entrega</p>

      <Toggle
        checked={draft.fallbackEnabled}
        onChange={(v) => patch({ fallbackEnabled: v })}
        title="Cobrar uma taxa padrão"
        desc="Vale para qualquer endereço sem bairro cadastrado abaixo. Desligado, a Livia não fecha entrega em bairro que você não listou."
      />
      {draft.fallbackEnabled && <div className="mt-2 max-w-[200px]">
        <Label>Taxa padrão (R$)</Label>
        <Input value={draft.fallbackFeeText} inputMode="decimal" placeholder="8,00" onChange={(e) => patch({ fallbackFeeText: e.target.value })} />
      </div>}

      <div className="mt-4">
        <Label hint="opcional">Taxa por bairro</Label>
        {draft.neighborhoods.length > 0 && <ul className="mt-1 space-y-2">
          {draft.neighborhoods.map((n) => <li key={n.key} className="flex flex-wrap items-center gap-2">
            <Input
              className="min-w-[140px] flex-1"
              value={n.name}
              placeholder="Centro"
              aria-label="Bairro"
              onChange={(e) => patch({ neighborhoods: draft.neighborhoods.map((item) => item.key === n.key ? { ...item, name: e.target.value } : item) })}
            />
            <Input
              className="w-[110px] shrink-0"
              value={n.feeText}
              inputMode="decimal"
              placeholder="6,00"
              aria-label={`Taxa do bairro ${n.name || "novo"}`}
              onChange={(e) => patch({ neighborhoods: draft.neighborhoods.map((item) => item.key === n.key ? { ...item, feeText: e.target.value } : item) })}
            />
            <Button size="sm" variant="secondary" onClick={() => patch({ neighborhoods: draft.neighborhoods.filter((item) => item.key !== n.key) })}>Remover</Button>
          </li>)}
        </ul>}
        <Button className="mt-2" size="sm" variant="secondary" onClick={() => patch({ neighborhoods: [...draft.neighborhoods, { key: nextKey(), name: "", feeText: "0,00" }] })}>Adicionar bairro</Button>
        <p className="mt-1.5 text-xs text-ink-400">Acento e maiúscula não importam: “Jardim América” e “jardim america” são o mesmo bairro.</p>
      </div>
    </div>}

    <div className="mt-4 border-t border-line/60 pt-4">
      <p className="mb-2 text-sm font-semibold text-ink-700">Formas de pagamento aceitas</p>
      <div className="flex flex-wrap gap-2">
        {PAYMENT_ORDER.map((method) => {
          const on = draft.methods.includes(method);
          return <Button key={method} size="sm" variant={on ? "primary" : "secondary"} aria-pressed={on} onClick={() => toggleMethod(method)}>{PAYMENT_LABELS[method]}</Button>;
        })}
      </div>
      <p className="mt-1.5 text-xs text-ink-400">A Livia só oferece o que estiver marcado aqui.</p>
    </div>

    {draft.methods.includes("pix") && <div className="mt-4">
      <Label hint="opcional">Instruções de PIX</Label>
      <Textarea
        value={draft.pixInstructions}
        placeholder={"Chave PIX: 11999998888 (celular)\nFavorecido: Lanchonete do Zé"}
        onChange={(e) => patch({ pixInstructions: e.target.value })}
      />
      <p className="mt-1.5 text-xs text-ink-400">Guardado agora para a Livia poder repassar ao cliente. Pagamento automático ainda não existe: a confirmação continua sendo sua.</p>
    </div>}

    <div className="mt-4 border-t border-line/60 pt-4">
      <p className="text-sm font-semibold text-ink-700">Templates fora da janela de 24 horas</p>
      <p className="mt-1 text-xs text-ink-400">Opcional. Informe apenas templates operacionais já aprovados na Meta. Sem configuração válida, a mudança do pedido continua e a notificação é registrada como não enviada.</p>
      <div className="mt-3 space-y-3">
        {NOTIFICATION_EVENTS.map(({ event, label }) => <div key={event} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px]">
          <div><Label hint="opcional">{label}</Label><Input aria-label={`Template — ${label}`} value={draft.notificationTemplates[event].templateName} placeholder="pedido_aceito" onChange={(e) => patch({ notificationTemplates: { ...draft.notificationTemplates, [event]: { ...draft.notificationTemplates[event], templateName: e.target.value } } })} /></div>
          <div><Label>Idioma</Label><Input aria-label={`Idioma — ${label}`} value={draft.notificationTemplates[event].languageCode} placeholder="pt_BR" onChange={(e) => patch({ notificationTemplates: { ...draft.notificationTemplates, [event]: { ...draft.notificationTemplates[event], languageCode: e.target.value } } })} /></div>
        </div>)}
      </div>
    </div>

    {error && <p className="mt-4 text-sm font-medium text-danger-fg">{error}</p>}
    <div className="mt-4 flex items-center gap-3">
      <Button disabled={saving} onClick={save}>{saving ? "Salvando…" : "Salvar configurações"}</Button>
      {saved && !error && <span className="text-sm text-ink-500">Salvo.</span>}
    </div>
  </Card>;
}
