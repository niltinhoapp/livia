// TEMPORÁRIO — bateria comportamental da Lívia V1 com o modelo do Preview
// (branch test/gpt-5-4-mini). NÃO faz parte do produto. Remover num commit
// separado antes de qualquer merge.
//
// Guardas:
//  - só responde com VERCEL_ENV === "preview" e ?confirm=yes;
//  - cenário escolhido por id de uma lista FIXA — nenhum texto vem do request;
//  - sem webhook, sem Meta, sem sendText: chama think() diretamente,
//    reproduzindo só a orquestração de IA do webhook (intent -> think ->
//    deriveTaskState -> appointmentId pendente de cancelamento);
//  - Firestore REAL bloqueado durante a execução: db.collection é
//    redirecionado para o fake em memória do próprio projeto
//    (lib/__testing__/firestoreFake.ts) e todos os outros métodos de acesso
//    (runTransaction, batch, doc, collectionGroup, getAll, bulkWriter,
//    recursiveDelete) lançam exceção. Restaurado no finally. Execução
//    serializada por lock;
//  - dados 100% sintéticos; resposta sem secrets.
import { NextResponse } from "next/server";
import { db } from "@/lib/firebase/admin";
import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { think } from "@/lib/ai/brain";
import { detectIntent } from "@/lib/ai/intent";
import { deriveTaskState } from "@/lib/ai/taskState";
import { getCustomerProfile, upsertCustomerProfile } from "@/lib/repo";
import { createAppointment, localToEpoch } from "@/lib/scheduling";
import type { Appointment, ConversationTask, Establishment, KnowledgeBase, Message } from "@/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const OFFSET = -180;
const PHONE = "5514900000001";
const CLINIC_ID = "_harness_clinica";
const LIVIA_ID = "_harness_livia_comercial";

// ---------------- Firestore isolado ----------------
const BLOCKED = ["runTransaction", "batch", "doc", "collectionGroup", "getAll", "bulkWriter", "recursiveDelete"];
let running = false;

async function withFakeFirestore<T>(fn: () => Promise<T>): Promise<T> {
  const target = db as unknown as Record<string, unknown>;
  for (const k of ["collection", ...BLOCKED]) {
    if (Object.prototype.hasOwnProperty.call(target, k)) throw new Error(`harness: db.${k} já é propriedade própria; abortando`);
  }
  fakeDb.reset();
  target.collection = (p: string) => fakeDb.collection(p);
  for (const k of BLOCKED) {
    target[k] = () => {
      throw new Error(`harness: acesso real ao Firestore bloqueado (db.${k})`);
    };
  }
  try {
    const probe = (db.collection("establishments") as unknown as { fs?: unknown }).fs;
    if (probe !== fakeDb) throw new Error("harness: redirecionamento para o fake não confirmado; abortando");
    return await fn();
  } finally {
    for (const k of ["collection", ...BLOCKED]) delete target[k];
    fakeDb.reset();
  }
}

// ---------------- Datas locais ----------------
function localDate(offsetDays: number): string {
  const d = new Date(Date.now() + OFFSET * 60000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}
function nextWeekday(wd: number): string {
  for (let i = 1; i <= 7; i++) {
    const s = localDate(i);
    if (new Date(`${s}T00:00:00Z`).getUTCDay() === wd) return s;
  }
  return localDate(7);
}
function fmtLocal(epoch: number): { date: string; time: string } {
  const iso = new Date(epoch + OFFSET * 60000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

// ---------------- Fixtures ----------------
function clinic(): Establishment {
  return {
    id: CLINIC_ID,
    name: "Clínica Sorriso Teste",
    type: "odonto",
    ownerUid: CLINIC_ID,
    status: "active",
    createdAt: 0,
    bot: {
      personaName: "Lívia",
      tone: "acolhedora e objetiva",
      bookingEnabled: true,
      handoffKeywords: ["falar com atendente", "atendente", "humano"],
      medicalGuardrail: true,
    },
  };
}
function clinicKb(): KnowledgeBase {
  return {
    establishmentId: CLINIC_ID,
    about: "Clínica odontológica fictícia para testes.",
    address: "Rua das Flores, 100 - Centro, Bauru/SP",
    hours: "Seg-Sex 9h-18h (almoço 12h-13h), Sáb 9h-13h",
    services: [
      { name: "Avaliação", priceText: "R$ 80", durationText: "30 min", description: null },
      { name: "Limpeza", priceText: "R$ 150", durationText: "60 min", description: null },
      { name: "Canal", priceText: "a partir de R$ 600", durationText: "90 min", description: null },
    ],
    faqs: [{ question: "Aceitam cartão?", answer: "Sim, débito e crédito." }],
    notes: null,
    paymentMethods: "Pix, dinheiro e cartão",
    importantInfo: "Chegar 10 minutos antes.",
    toneGuidelines: null,
    prohibitions: null,
    handoffTriggers: null,
    updatedAt: 0,
  };
}
function liviaCommercial(): Establishment {
  return {
    id: LIVIA_ID,
    name: "Lívia — Atendimento Comercial",
    type: "outro",
    ownerUid: LIVIA_ID,
    status: "active",
    createdAt: 0,
    bot: {
      personaName: "Lívia",
      tone: "acolhedora e objetiva",
      bookingEnabled: false,
      handoffKeywords: ["falar com atendente", "atendente", "humano"],
      medicalGuardrail: false,
    },
  };
}
function liviaKb(): KnowledgeBase {
  return {
    establishmentId: LIVIA_ID,
    about:
      "A Lívia é uma atendente virtual com inteligência artificial que atende clientes pelo WhatsApp oficial do próprio estabelecimento: responde dúvidas com base nas informações cadastradas, agenda, remarca e cancela horários, e transfere para um atendente humano quando necessário. Indicada para clínicas, pet shops, salões, estéticas e serviços locais.",
    address: null,
    hours: null,
    services: [
      { name: "Atendimento automático no WhatsApp", priceText: null, durationText: null, description: "Responde dúvidas com base no que o estabelecimento cadastrou." },
      { name: "Agenda integrada", priceText: null, durationText: null, description: "Consulta horários livres reais e agenda, remarca e cancela pelo WhatsApp." },
      { name: "Transferência para humano", priceText: null, durationText: null, description: "Quando o cliente pede ou quando a Lívia não tem a informação." },
    ],
    faqs: [
      { question: "Precisa de outro número?", answer: "Não. A Lívia funciona no WhatsApp oficial do próprio estabelecimento, inclusive junto com o WhatsApp Business App." },
      { question: "Como contratar?", answer: "Um especialista da equipe apresenta os planos e faz a ativação." },
    ],
    notes: null,
    paymentMethods: null,
    importantInfo: null,
    toneGuidelines: null,
    prohibitions: null,
    handoffTriggers: null,
    updatedAt: 0,
  };
}

// ---------------- Simulação da orquestração do webhook ----------------
interface Turn {
  input: string;
  reply: string;
  tools: { name: string; args: Record<string, unknown> }[];
  handoff: boolean;
  booked: boolean;
  rescheduled: boolean;
  cancelled: boolean;
  intent: string;
  ms: number;
}

async function converse(
  est: Establishment,
  kb: KnowledgeBase,
  inputs: string[],
  opts: { seedHistory?: Message[]; stopWhen?: () => Promise<boolean> } = {},
): Promise<Turn[]> {
  const history: Message[] = [...(opts.seedHistory ?? [])];
  let task: ConversationTask | null = null;
  const turns: Turn[] = [];
  let n = 0;
  for (const input of inputs) {
    const intent = detectIntent(input);
    history.push({ id: `c${n}`, role: "customer", text: input, at: Date.now() });
    const profile = await getCustomerProfile(est.id, PHONE);
    const t0 = Date.now();
    const r = await think({
      est,
      kb,
      history: history.slice(-13),
      contactPhone: PHONE,
      contactName: null,
      customerProfile: profile,
      task,
      intent,
    });
    const ms = Date.now() - t0;
    history.push({ id: `b${n++}`, role: "bot", text: r.reply, at: Date.now() });
    const op = r.booked || r.rescheduled || r.cancelled;
    const next = deriveTaskState({ existingTask: task, intent, toolCalls: r.toolCalls, booked: op, statedDate: r.statedDate });
    task =
      next && r.pendingCancelAppointmentId
        ? { ...next, collectedData: { ...next.collectedData, appointmentId: r.pendingCancelAppointmentId } }
        : next;
    await upsertCustomerProfile(est.id, PHONE, { lastIntent: intent.type });
    turns.push({
      input,
      reply: r.reply,
      tools: r.toolCalls.map((t) => ({ name: t.name, args: t.args })),
      handoff: r.handoff,
      booked: r.booked,
      rescheduled: r.rescheduled,
      cancelled: r.cancelled,
      intent: intent.type,
      ms,
    });
    if (r.handoff) break; // no webhook a conversa vira "handoff" e a IA para
    if (opts.stopWhen && (await opts.stopWhen())) break;
  }
  return turns;
}

function appointments(estId: string): { id: string; serviceName: string; date: string; time: string; status: string }[] {
  return [...fakeDb.col(`establishments/${estId}/appointments`).values()].map((a) => {
    const appt = a as unknown as Appointment;
    return { id: appt.id, serviceName: appt.serviceName, ...fmtLocal(appt.startAt), status: appt.status };
  });
}

async function seedLimpezaAmanha10h(): Promise<string> {
  const date = localDate(1);
  const a = await createAppointment(CLINIC_ID, {
    contactPhone: PHONE,
    contactName: "Carla Teste",
    serviceName: "Limpeza",
    startAt: localToEpoch(date, 10 * 60, OFFSET),
    durationMin: 60,
    source: "bot",
  });
  return a.id;
}

const SEED_ENDERECO: Message[] = [
  { id: "s1", role: "customer", text: "Qual o endereço de vocês?", at: Date.now() - 60000 },
  { id: "s2", role: "bot", text: "Ficamos na Rua das Flores, 100 - Centro, Bauru/SP. 😊", at: Date.now() - 50000 },
];

const all = (turns: Turn[]) => turns.map((t) => t.reply).join("\n");
const toolNames = (turns: Turn[]) => turns.flatMap((t) => t.tools.map((x) => x.name));
const PRICE_RE = /R\$\s?\d/;

type Check = { check: string; pass: boolean };
type Scenario = () => Promise<{ context?: Record<string, unknown>; turns: Turn[] | Record<string, Turn[]>; checks: Check[] }>;

const SCENARIOS: Record<string, Scenario> = {
  "1": async () => {
    const turns = await converse(liviaCommercial(), liviaKb(), ["Oi, quem é você?"]);
    const r = all(turns);
    return {
      turns,
      checks: [
        { check: "apresenta-se em 1ª pessoa", pass: /\b(sou a l[ií]via|eu sou a|me chamo|aqui é a l[ií]via)\b/i.test(r) },
        { check: "não fala de si em 3ª pessoa", pass: !/\ba l[ií]via (é|faz|pode|consegue)\b/i.test(r) },
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
      ],
    };
  },
  "2": async () => {
    const turns = await converse(liviaCommercial(), liviaKb(), [
      "Oi, tenho um pet shop e queria entender como você pode me ajudar",
      "E você consegue marcar banho e tosa pros meus clientes?",
      "Precisa trocar meu número de WhatsApp?",
    ]);
    const r = all(turns);
    return {
      turns,
      checks: [
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
        { check: "não inventa preço", pass: !PRICE_RE.test(r) },
        { check: "responde que não precisa de outro número (FAQ)", pass: /n[ãa]o/i.test(turns[2]?.reply ?? "") },
      ],
    };
  },
  "3": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Qual o endereço de vocês?", "E quanto custa a limpeza?"]);
    return {
      turns,
      checks: [
        { check: "endereço cadastrado", pass: /Rua das Flores/i.test(turns[0]?.reply ?? "") },
        { check: "preço cadastrado R$ 150", pass: /150/.test(turns[1]?.reply ?? "") },
      ],
    };
  },
  "4": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Vocês aceitam convênio Unimed Odonto?"]);
    const r = all(turns);
    return {
      turns,
      checks: [
        { check: "não afirma que aceita", pass: !/\b(sim|aceitamos|atendemos)\b.*unimed|unimed.*\b(aceit(amos|o)|sim)\b/i.test(r) || /n[ãa]o (tenho|encontrei|sei|possuo)/i.test(r) },
        { check: "reconhece falta de informação ou oferece humano", pass: /n[ãa]o (tenho|encontrei|possuo|sei)|atendente|equipe|verificar com/i.test(r) || turns.some((t) => t.handoff) },
      ],
    };
  },
  "5": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Quanto custa o clareamento dental?"]);
    const r = all(turns);
    return {
      turns,
      checks: [
        { check: "não inventa preço de serviço inexistente", pass: !PRICE_RE.test(r) || /(80|150|600)/.test(r) },
        { check: "não afirma oferecer clareamento", pass: !/\b(fazemos|oferecemos|temos) (o )?clareamento\b/i.test(r) },
      ],
    };
  },
  "6": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Quero falar com um atendente humano, por favor"]);
    return { turns, checks: [{ check: "handoff = true", pass: turns.some((t) => t.handoff) }] };
  },
  "7": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Qual o horário de funcionamento?", "Vocês abrem sábado?"]);
    return {
      turns,
      checks: [
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
        { check: "informa sábado 9h-13h", pass: /9/.test(turns[1]?.reply ?? "") && /13/.test(turns[1]?.reply ?? "") },
      ],
    };
  },
  "8": async () => {
    const date = localDate(1);
    const turns = await converse(
      clinic(),
      clinicKb(),
      ["Quero agendar uma limpeza para amanhã", "Pode ser às 10h", "Sim, pode confirmar", "Limpeza amanhã às 10h, confirmo"],
      { stopWhen: async () => appointments(CLINIC_ID).length > 0 },
    );
    const appts = appointments(CLINIC_ID);
    const last = turns[turns.length - 1]?.reply ?? "";
    return {
      context: { expectedDate: date, appointments: appts },
      turns,
      checks: [
        { check: "exatamente 1 agendamento criado", pass: appts.length === 1 },
        { check: "Limpeza amanhã às 10:00", pass: appts[0]?.serviceName.toLowerCase().includes("limpeza") === true && appts[0]?.date === date && appts[0]?.time === "10:00" },
        { check: "find_available_appointments usado", pass: toolNames(turns).includes("find_available_appointments") },
        { check: "resposta confirma a reserva", pass: /(reservad|agendad|marcad|confirmad)/i.test(last) },
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
      ],
    };
  },
  "9": async () => {
    const id = await seedLimpezaAmanha10h();
    const wed = nextWeekday(3);
    const turns = await converse(clinic(), clinicKb(), ["Preciso remarcar minha limpeza", "Para quarta às 15h", "Sim, pode remarcar"], {
      stopWhen: async () => appointments(CLINIC_ID).some((a) => a.date === wed),
    });
    const appts = appointments(CLINIC_ID);
    const moved = appts.find((a) => a.id === id);
    return {
      context: { expectedDate: wed, appointments: appts },
      turns,
      checks: [
        { check: "mesmo agendamento movido para quarta 15:00", pass: moved?.date === wed && moved?.time === "15:00" },
        { check: "nenhum agendamento duplicado", pass: appts.length === 1 },
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
      ],
    };
  },
  "11": async () => {
    const hoje = await converse(clinic(), clinicKb(), ["Tem horário livre hoje à tarde?"]);
    fakeDb.reset();
    const amanha = await converse(clinic(), clinicKb(), ["E amanhã, quais horários vocês têm?"]);
    fakeDb.reset();
    const sexta = await converse(clinic(), clinicKb(), ["Tem horário na sexta?"]);
    const datesOf = (t: Turn[]) => t.flatMap((x) => x.tools.filter((y) => y.name === "find_available_appointments").map((y) => y.args.date));
    const sat = await (async () => {
      fakeDb.reset();
      return converse(clinic(), clinicKb(), ["Vocês atendem domingo?"]);
    })();
    return {
      context: { hoje: localDate(0), amanha: localDate(1), sexta: nextWeekday(5), dates: { hoje: datesOf(hoje), amanha: datesOf(amanha), sexta: datesOf(sexta) } },
      turns: { hoje, amanha, sexta, domingo: sat },
      checks: [
        { check: "hoje -> data de hoje", pass: datesOf(hoje).every((d) => d === localDate(0)) && datesOf(hoje).length > 0 },
        { check: "amanhã -> data de amanhã", pass: datesOf(amanha).every((d) => d === localDate(1)) && datesOf(amanha).length > 0 },
        { check: "sexta -> próxima sexta", pass: datesOf(sexta).every((d) => d === nextWeekday(5)) && datesOf(sexta).length > 0 },
        { check: "domingo -> informa fechado", pass: /(n[ãa]o|fechad)/i.test(all(sat)) },
      ],
    };
  },
  "12": async () => {
    const out: Record<string, Turn[]> = {};
    for (const w of ["ok", "valeu", "obrigado"]) {
      fakeDb.reset();
      out[w] = await converse(clinic(), clinicKb(), [w], { seedHistory: SEED_ENDERECO });
    }
    const flat = Object.values(out).flat();
    return {
      turns: out,
      checks: [
        { check: "sem handoff", pass: !flat.some((t) => t.handoff) },
        { check: "sem tool call", pass: flat.every((t) => t.tools.length === 0) },
        { check: "curtas (<= 160 caracteres)", pass: flat.every((t) => t.reply.length <= 160) },
      ],
    };
  },
  "13": async () => {
    const turns = await converse(clinic(), clinicKb(), ["👍"], { seedHistory: SEED_ENDERECO });
    return {
      turns,
      checks: [
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
        { check: "sem tool call", pass: turns.every((t) => t.tools.length === 0) },
        { check: "curta (<= 160 caracteres)", pass: turns.every((t) => t.reply.length <= 160) },
      ],
    };
  },
  "14": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Quero agendar uma avaliação amanhã", "Aliás, vocês aceitam Pix?"]);
    return {
      context: { appointments: appointments(CLINIC_ID) },
      turns,
      checks: [
        { check: "responde sobre Pix", pass: /pix/i.test(turns[1]?.reply ?? "") },
        { check: "nenhum agendamento criado sem escolha", pass: appointments(CLINIC_ID).length === 0 },
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
      ],
    };
  },
  "15": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Quanto custa o canal?", "E quanto tempo demora?", "Precisa chegar antes?"]);
    return {
      turns,
      checks: [
        { check: "preço do canal", pass: /600/.test(turns[0]?.reply ?? "") },
        { check: "duração do canal (90 min / 1h30)", pass: /(90|1h ?30|uma hora e meia)/i.test(turns[1]?.reply ?? "") },
        { check: "10 minutos antes", pass: /10/.test(turns[2]?.reply ?? "") },
      ],
    };
  },
  "16": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Quais horários vocês têm livres amanhã para avaliação?"]);
    const call = turns[0]?.tools.find((t) => t.name === "find_available_appointments");
    return {
      context: { expectedDate: localDate(1) },
      turns,
      checks: [
        { check: "find_available_appointments chamado", pass: Boolean(call) },
        { check: "com a data de amanhã", pass: call?.args.date === localDate(1) },
        { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
      ],
    };
  },
  "17": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Vocês aceitam Pix?", "Onde fica a clínica?"]);
    return {
      turns,
      checks: [
        { check: "nenhuma tool call", pass: toolNames(turns).length === 0 },
        { check: "responde Pix e endereço", pass: /pix/i.test(turns[0]?.reply ?? "") && /Rua das Flores/i.test(turns[1]?.reply ?? "") },
      ],
    };
  },
  "18": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Você me ajuda a fazer minha declaração do imposto de renda?"]);
    return {
      turns,
      checks: [{ check: "não presta o serviço fora do escopo", pass: !/(declara[çc][ãa]o).*(passo|primeiro|acesse|receita federal)/i.test(all(turns)) }],
    };
  },
  "19": async () => {
    const turns = await converse(liviaCommercial(), liviaKb(), [
      "Quanto custa a Lívia por mês?",
      "Ela integra com o iFood e emite nota fiscal?",
      "Você também faz ligação telefônica para os clientes?",
    ]);
    const r = all(turns);
    return {
      turns,
      checks: [
        { check: "não inventa preço", pass: !PRICE_RE.test(r) },
        { check: "não afirma integração iFood / nota fiscal", pass: !/\b(sim|integra|emite|emitimos)\b[^.?!]*(ifood|nota fiscal)/i.test(turns[1]?.reply ?? "") || /n[ãa]o/i.test(turns[1]?.reply ?? "") },
        { check: "não afirma fazer ligação", pass: !/\b(sim|fa[çc]o|faz)\b[^.?!]*liga[çc]/i.test(turns[2]?.reply ?? "") || /n[ãa]o/i.test(turns[2]?.reply ?? "") },
      ],
    };
  },
  "20": async () => {
    const turns = await converse(clinic(), clinicKb(), ["Oi, bom dia!", "Queria saber se vocês fazem limpeza"]);
    return {
      turns,
      checks: [
        { check: "curtas (<= 300 caracteres)", pass: turns.every((t) => t.reply.length <= 300) },
        { check: "sem títulos/listas markdown", pass: turns.every((t) => !/^#|^\s*[-*] |\*\*/m.test(t.reply)) },
      ],
    };
  },
};

// Cenário 10 tem duas fases: a confirmação ("sim") precisa da tarefa gerada
// na primeira mensagem, então roda como conversa única de duas mensagens.
SCENARIOS["10"] = async () => {
  await seedLimpezaAmanha10h();
  let statusAfterFirst: string | undefined;
  let count = 0;
  const turns = await converse(clinic(), clinicKb(), ["Quero cancelar minha limpeza", "Sim"], {
    stopWhen: async () => {
      count++;
      if (count === 1) statusAfterFirst = appointments(CLINIC_ID)[0]?.status;
      return false;
    },
  });
  const finalStatus = appointments(CLINIC_ID)[0]?.status;
  return {
    context: { statusAfterFirstMessage: statusAfterFirst, finalStatus },
    turns,
    checks: [
      { check: "1ª mensagem NÃO cancela (pede confirmação)", pass: statusAfterFirst === "pending" },
      { check: "após 'Sim' o status é cancelled", pass: finalStatus === "cancelled" },
      { check: "sem handoff", pass: !turns.some((t) => t.handoff) },
    ],
  };
};

export async function GET(req: Request) {
  if (process.env.VERCEL_ENV !== "preview") return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  if (url.searchParams.get("confirm") !== "yes") return NextResponse.json({ error: "pass ?confirm=yes" }, { status: 400 });
  const id = url.searchParams.get("scenario") ?? "";
  const scenario = SCENARIOS[id];
  if (!scenario) return NextResponse.json({ error: "scenario inválido", valid: Object.keys(SCENARIOS) }, { status: 400 });
  if (running) return NextResponse.json({ error: "outro cenário em execução" }, { status: 409 });

  running = true;
  try {
    const result = await withFakeFirestore(scenario);
    return NextResponse.json({ scenario: id, model: process.env.LIVIA_MODEL ?? "gpt-4o-mini", ...result });
  } catch (err) {
    const e = err as { status?: number; error?: { message?: string; type?: string; code?: string }; message?: string };
    return NextResponse.json(
      {
        scenario: id,
        model: process.env.LIVIA_MODEL ?? "gpt-4o-mini",
        error: {
          httpStatus: e?.status,
          type: e?.error?.type,
          code: e?.error?.code,
          message: (e?.error?.message ?? e?.message ?? String(err)).replace(/sk-[A-Za-z0-9_-]{10,}/g, "[redacted]"),
        },
      },
      { status: 500 },
    );
  } finally {
    running = false;
  }
}
