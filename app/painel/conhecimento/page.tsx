"use client";
// Painel: "Ensine a Livia" — base de conhecimento do estabelecimento,
// guiada por seções em linguagem simples (o comerciante nunca vê nome de
// campo técnico nem prompt). Cada seção tem explicação + exemplo pronto
// ("Usar exemplo") + edição livre. Um modelo por segmento pode preencher
// tudo de uma vez, mas SÓ nos campos que ainda estão vazios — nunca
// sobrescreve o que o comerciante já escreveu.
//
// Tenant vem da sessão (cookie httpOnly criado no login); o painel só é
// renderizado se app/painel/layout.tsx confirmar uma sessão válida.
import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  Tags,
  Wallet,
  Info,
  MessageCircle,
  ShieldAlert,
  UserCheck,
  HelpCircle,
  Plus,
  Trash2,
  Sparkles,
} from "lucide-react";
import type { EstablishmentType, KnowledgeService, KnowledgeFaq } from "@/types";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Label, Textarea } from "@/components/ui/Field";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingState, ErrorState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { GuidedSection } from "@/components/knowledge/GuidedSection";
import { KNOWLEDGE_TEMPLATES, suggestedTemplateFor, type KnowledgeTemplate } from "@/components/knowledge/templates";

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

export default function KnowledgePanel() {
  const [state, setState] = useState<SaveState>("loading");
  const [loadError, setLoadError] = useState(false);

  const [establishmentType, setEstablishmentType] = useState<EstablishmentType>("outro");
  const [about, setAbout] = useState("");
  const [address, setAddress] = useState("");
  const [hours, setHours] = useState("");
  const [paymentMethods, setPaymentMethods] = useState("");
  const [importantInfo, setImportantInfo] = useState("");
  const [toneGuidelines, setToneGuidelines] = useState("");
  const [prohibitions, setProhibitions] = useState("");
  const [handoffTriggers, setHandoffTriggers] = useState("");
  const [services, setServices] = useState<KnowledgeService[]>([]);
  const [faqs, setFaqs] = useState<KnowledgeFaq[]>([]);

  const [activeTemplateId, setActiveTemplateId] = useState<string>(KNOWLEDGE_TEMPLATES[0]!.id);
  const [confirmApply, setConfirmApply] = useState(false);

  const load = useCallback(() => {
    setLoadError(false);
    setState("loading");
    Promise.all([
      fetch("/api/knowledge").then((r) => r.json()),
      fetch("/api/establishment").then((r) => r.json()),
    ])
      .then(([kd, ed]) => {
        const kb = kd.knowledge;
        if (kb) {
          setAbout(kb.about ?? "");
          setAddress(kb.address ?? "");
          setHours(kb.hours ?? "");
          setPaymentMethods(kb.paymentMethods ?? "");
          setImportantInfo(kb.importantInfo ?? "");
          setToneGuidelines(kb.toneGuidelines ?? "");
          setProhibitions(kb.prohibitions ?? "");
          setHandoffTriggers(kb.handoffTriggers ?? "");
          setServices(kb.services ?? []);
          setFaqs(kb.faqs ?? []);
        }
        const type: EstablishmentType = ed.establishment?.type ?? "outro";
        setEstablishmentType(type);
        const suggested = suggestedTemplateFor(type);
        if (suggested) setActiveTemplateId(suggested.id);
        setState("idle");
      })
      .catch(() => {
        setLoadError(true);
        setState("idle");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async () => {
    setState("saving");
    const res = await fetch("/api/knowledge", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        about,
        address,
        hours,
        paymentMethods,
        importantInfo,
        toneGuidelines,
        prohibitions,
        handoffTriggers,
        services,
        faqs,
      }),
    });
    setState(res.ok ? "saved" : "error");
    if (res.ok) setTimeout(() => setState("idle"), 2000);
  }, [about, address, hours, paymentMethods, importantInfo, toneGuidelines, prohibitions, handoffTriggers, services, faqs]);

  if (state === "loading") return <LoadingState />;
  if (loadError) return <ErrorState onRetry={load} />;

  const activeTemplate = KNOWLEDGE_TEMPLATES.find((t) => t.id === activeTemplateId)!;
  const suggested = suggestedTemplateFor(establishmentType);

  function applyTemplate(t: KnowledgeTemplate) {
    // Só preenche o que estiver vazio — nunca sobrescreve o que já existe.
    if (!about.trim()) setAbout(t.about);
    if (services.length === 0) setServices(t.services);
    if (!paymentMethods.trim()) setPaymentMethods(t.paymentMethods);
    if (!importantInfo.trim()) setImportantInfo(t.importantInfo);
    if (!toneGuidelines.trim()) setToneGuidelines(t.toneGuidelines);
    if (!prohibitions.trim()) setProhibitions(t.prohibitions);
    if (!handoffTriggers.trim()) setHandoffTriggers(t.handoffTriggers);
    setConfirmApply(false);
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Ensine a Livia"
        description="Conte pra Livia como seu negócio funciona. Quanto mais completo, melhor ela atende — e ela só fala o que estiver aqui, nunca inventa."
      />

      {/* ---- Modelo por segmento ---- */}
      <Card className="mb-5 border-dashed bg-primary-light/30">
        <div className="mb-3 flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="text-sm font-semibold text-ink-900">Não sabe por onde começar?</p>
        </div>
        <p className="mb-3 text-sm text-ink-500">
          Escolha um modelo pronto pro seu tipo de negócio. Ele só preenche os campos que ainda estão vazios — nada do que você já escreveu é apagado.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {KNOWLEDGE_TEMPLATES.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTemplateId(t.id)}
              className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition-colors ${
                activeTemplateId === t.id
                  ? "border-primary bg-primary text-white"
                  : "border-line bg-white text-ink-700 hover:bg-line/30"
              }`}
            >
              {t.label}
              {suggested?.id === t.id && (
                <span className="ml-1.5 rounded-full bg-success-bg px-1.5 py-0.5 text-[10px] font-bold text-success-fg">
                  recomendado
                </span>
              )}
            </button>
          ))}
        </div>
        <Button size="sm" onClick={() => setConfirmApply(true)}>
          Usar o modelo &quot;{activeTemplate.label}&quot;
        </Button>
      </Card>

      <ConfirmDialog
        open={confirmApply}
        title={`Aplicar o modelo "${activeTemplate.label}"?`}
        description="Só preenche os campos que ainda estiverem vazios. O que você já escreveu não é alterado."
        confirmLabel="Aplicar"
        onConfirm={() => applyTemplate(activeTemplate)}
        onCancel={() => setConfirmApply(false)}
      />

      {/* ---- 1. Sobre a empresa ---- */}
      <GuidedSection
        icon={<Building2 className="h-4 w-4" />}
        title="1. Sobre a empresa"
        helper='Conte em poucas frases o que é o seu negócio. Ex.: "Somos uma clínica odontológica em Macatuba. Atendemos adultos e crianças e buscamos oferecer um atendimento acolhedor."'
        onUseExample={() => setAbout(activeTemplate.about)}
      >
        <Textarea value={about} onChange={(e) => setAbout(e.target.value)} placeholder={activeTemplate.about} />
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <Label hint="(opcional)">Endereço</Label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Rua, número, bairro, cidade" />
          </div>
          <div>
            <Label hint="(texto que a Livia fala pro cliente)">Horário de funcionamento</Label>
            <Input value={hours} onChange={(e) => setHours(e.target.value)} placeholder="Seg-Sex 9h-18h, Sáb 9h-13h" />
          </div>
        </div>
      </GuidedSection>

      {/* ---- 2. Serviços e preços ---- */}
      <GuidedSection
        icon={<Tags className="h-4 w-4" />}
        title="2. Serviços e preços"
        helper='Liste o que você oferece e o preço. Ex.: "Limpeza: R$150. Avaliação: R$100. Clareamento: a partir de R$600."'
        onUseExample={() => setServices(activeTemplate.services)}
      >
        {services.length === 0 && <p className="text-sm text-ink-400">Nenhum serviço ainda.</p>}
        {services.map((s, i) => (
          <div key={i} className={i ? "mt-3 border-t border-line pt-3" : ""}>
            <div className="flex flex-wrap gap-2">
              <Input className="flex-1 basis-[200px]" value={s.name} onChange={(e) => updAt(services, setServices, i, { name: e.target.value })} placeholder="Nome do serviço" />
              <Input className="flex-1 basis-[160px]" value={s.priceText ?? ""} onChange={(e) => updAt(services, setServices, i, { priceText: e.target.value })} placeholder="Preço (ex.: a partir de R$ 80)" />
              <Input className="flex-1 basis-[100px]" value={s.durationText ?? ""} onChange={(e) => updAt(services, setServices, i, { durationText: e.target.value })} placeholder="Duração" />
            </div>
            <Input className="mt-2" value={s.description ?? ""} onChange={(e) => updAt(services, setServices, i, { description: e.target.value })} placeholder="Descrição (opcional)" />
            <button
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-danger-fg hover:underline"
              onClick={() => setServices(services.filter((_, x) => x !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remover
            </button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="mt-3"
          onClick={() => setServices([...services, { name: "", priceText: null, durationText: null, description: null }])}
        >
          <Plus className="h-3.5 w-3.5" /> Adicionar serviço
        </Button>
      </GuidedSection>

      {/* ---- 3. Formas de pagamento ---- */}
      <GuidedSection
        icon={<Wallet className="h-4 w-4" />}
        title="3. Formas de pagamento"
        helper='Ex.: "Aceitamos Pix, dinheiro, cartão de débito e crédito."'
        onUseExample={() => setPaymentMethods(activeTemplate.paymentMethods)}
      >
        <Textarea value={paymentMethods} onChange={(e) => setPaymentMethods(e.target.value)} placeholder={activeTemplate.paymentMethods} />
      </GuidedSection>

      {/* ---- 4. Informações importantes ---- */}
      <GuidedSection
        icon={<Info className="h-4 w-4" />}
        title="4. Informações importantes"
        helper='Coisas que o cliente precisa saber antes de vir. Ex.: "Para primeira consulta, trazer documento com foto. Chegar 10 minutos antes."'
        onUseExample={() => setImportantInfo(activeTemplate.importantInfo)}
      >
        <Textarea value={importantInfo} onChange={(e) => setImportantInfo(e.target.value)} placeholder={activeTemplate.importantInfo} />
      </GuidedSection>

      {/* ---- 5. Como a Livia deve conversar ---- */}
      <GuidedSection
        icon={<MessageCircle className="h-4 w-4" />}
        title="5. Como a Livia deve conversar"
        helper='Ex.: "Seja simpática e natural. Use mensagens curtas. Chame o cliente pelo primeiro nome. Faça uma pergunta por vez."'
        onUseExample={() => setToneGuidelines(activeTemplate.toneGuidelines)}
      >
        <Textarea value={toneGuidelines} onChange={(e) => setToneGuidelines(e.target.value)} placeholder={activeTemplate.toneGuidelines} />
      </GuidedSection>

      {/* ---- 6. O que a Livia não deve fazer ---- */}
      <GuidedSection
        icon={<ShieldAlert className="h-4 w-4" />}
        title="6. O que a Livia não deve fazer"
        helper='Ex.: "Não fornecer diagnóstico. Não inventar preços. Não prometer horários sem consultar a agenda."'
        onUseExample={() => setProhibitions(activeTemplate.prohibitions)}
      >
        <Textarea value={prohibitions} onChange={(e) => setProhibitions(e.target.value)} placeholder={activeTemplate.prohibitions} />
      </GuidedSection>

      {/* ---- 7. Quando chamar um atendente humano ---- */}
      <GuidedSection
        icon={<UserCheck className="h-4 w-4" />}
        title="7. Quando chamar um atendente humano"
        helper='Ex.: "Reclamações. Urgências. Pedido de desconto. Cliente irritado."'
        onUseExample={() => setHandoffTriggers(activeTemplate.handoffTriggers)}
      >
        <Textarea value={handoffTriggers} onChange={(e) => setHandoffTriggers(e.target.value)} placeholder={activeTemplate.handoffTriggers} />
      </GuidedSection>

      {/* ---- Perguntas frequentes (opcional) ---- */}
      <GuidedSection icon={<HelpCircle className="h-4 w-4" />} title="Perguntas frequentes" helper="Dúvidas comuns que os clientes fazem, com a resposta pronta.">
        {faqs.length === 0 && <p className="text-sm text-ink-400">Nenhuma pergunta ainda.</p>}
        {faqs.map((f, i) => (
          <div key={i} className={i ? "mt-3 border-t border-line pt-3" : ""}>
            <Input value={f.question} onChange={(e) => updAt(faqs, setFaqs, i, { question: e.target.value })} placeholder="Pergunta (ex.: Vocês atendem convênio?)" />
            <Textarea className="mt-2 min-h-[56px]" value={f.answer} onChange={(e) => updAt(faqs, setFaqs, i, { answer: e.target.value })} placeholder="Resposta" />
            <button
              className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-danger-fg hover:underline"
              onClick={() => setFaqs(faqs.filter((_, x) => x !== i))}
            >
              <Trash2 className="h-3.5 w-3.5" /> Remover
            </button>
          </div>
        ))}
        <Button variant="ghost" size="sm" className="mt-3" onClick={() => setFaqs([...faqs, { question: "", answer: "" }])}>
          <Plus className="h-3.5 w-3.5" /> Adicionar pergunta
        </Button>
      </GuidedSection>

      <div className="flex items-center gap-4">
        <Button disabled={state === "saving"} onClick={save}>
          {state === "saving" ? "Salvando…" : "Salvar"}
        </Button>
        {state === "saved" && <span className="text-sm font-semibold text-success-fg">Salvo!</span>}
        {state === "error" && <span className="text-sm font-semibold text-danger-fg">Erro ao salvar.</span>}
      </div>
    </div>
  );
}

function updAt<T>(arr: T[], setArr: (v: T[]) => void, i: number, patch: Partial<T>) {
  setArr(arr.map((item, x) => (x === i ? { ...item, ...patch } : item)));
}
