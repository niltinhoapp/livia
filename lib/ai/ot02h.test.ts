// OT-02H — parser lexical seguro + reconhecimento de remarcação e alvo por
// serviço. Unit (parser/intent) + integração (fluxo real com Firestore falso).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseServiceSelection } from "@/lib/ai/serviceSelection";
import { detectIntent } from "@/lib/ai/intent";
import type { KnowledgeService } from "@/types";

// ---------- Parte A: parser lexical ----------
describe("parseServiceSelection — fronteira de palavra", () => {
  const curtos: KnowledgeService[] = [
    { name: "Ana", priceText: null, durationText: null, description: null },
    { name: "Corte", priceText: null, durationText: null, description: null },
    { name: "Gel", priceText: null, durationText: null, description: null },
  ];
  it("não casa dentro de outra palavra", () => {
    expect(parseServiceSelection("quero uma banana", curtos)).toBeNull();     // Ana ⊄ banana
    expect(parseServiceSelection("faça um recorte", curtos)).toBeNull();      // Corte ⊄ recorte
    expect(parseServiceSelection("um doce gelado", curtos)).toBeNull();       // Gel ⊄ gelado
  });
  it("casa o nome completo como unidade lexical", () => {
    expect(parseServiceSelection("pode ser com a Ana", curtos)).toBe("Ana");
    expect(parseServiceSelection("quero corte", curtos)).toBe("Corte");
    expect(parseServiceSelection("aplicar gel, por favor", curtos)).toBe("Gel");
  });

  const comAcento: KnowledgeService[] = [
    { name: "Avaliação", priceText: null, durationText: null, description: null },
    { name: "Tratamento de Canal", priceText: null, durationText: null, description: null },
  ];
  it("case e acento insensível, nome completo", () => {
    expect(parseServiceSelection("QUERO AVALIACAO", comAcento)).toBe("Avaliação");
    expect(parseServiceSelection("marcar avaliação amanhã", comAcento)).toBe("Avaliação");
    expect(parseServiceSelection("tratamento de canal", comAcento)).toBe("Tratamento de Canal");
  });
  it("ambiguidade/sobreposição → null", () => {
    // dois nomes COMPLETOS distintos citados → não escolhe
    expect(parseServiceSelection("avaliação e tratamento de canal", comAcento)).toBeNull();
    // "canal" sozinho NÃO é um serviço cadastrado (só "Tratamento de Canal"),
    // então "avaliação e canal" reconhece apenas Avaliação — comportamento correto
    expect(parseServiceSelection("avaliação e canal", comAcento)).toBe("Avaliação");
    const overlap: KnowledgeService[] = [
      { name: "Canal", priceText: null, durationText: null, description: null },
      { name: "Tratamento de Canal", priceText: null, durationText: null, description: null },
    ];
    expect(parseServiceSelection("quero tratamento de canal", overlap)).toBeNull();     // ambos casam
  });
});

// ---------- Parte B1: intenção de remarcação ----------
describe("detectIntent — remarcação", () => {
  it.each([
    "remarca",
    "Remarca tbm pra amanha as 10 avaliação",
    "remarcar",
    "quero remarcar",
    "remarque meu horário",
    "reagenda meu horario",
    "quero mudar meu horário",
    "trocar meu horário",
  ])("'%s' → reschedule_appointment", (t) => {
    expect(detectIntent(t).type).toBe("reschedule_appointment");
  });
  it("não amplia genéricos soltos", () => {
    expect(detectIntent("quero mudar de assunto").type).not.toBe("reschedule_appointment");
    expect(detectIntent("vou trocar de roupa").type).not.toBe("reschedule_appointment");
  });
  it("cancelar ainda vence remarcar quando ambos aparecem", () => {
    expect(detectIntent("cancela e depois remarca").type).toBe("cancel_appointment");
  });
});

// ---------- Parte B2 + fluxo: integração real ----------
vi.mock("@/lib/firebase/admin", async () => {
  const f = await import("@/lib/__testing__/firestoreFake");
  return { sub: f.sub, establishmentRef: f.establishmentRef, db: f.fakeDb };
});
type MM = { content: string | null; tool_calls?: unknown[] };
let modelScript: MM[] = [];
vi.mock("openai", () => ({ default: class { chat = { completions: { create: async () => ({ choices: [{ message: modelScript.shift() ?? { content: "ok" } }] }) } }; } }));

const { fakeDb } = await import("@/lib/__testing__/firestoreFake");
const { think } = await import("@/lib/ai/brain");
const { deriveTaskState } = await import("@/lib/ai/taskState");
const { createAppointment, saveScheduleConfig, defaultScheduleConfig } = await import("@/lib/scheduling");
type A = import("@/types").Appointment; type CT = import("@/types").ConversationTask;
type Est = import("@/types").Establishment; type KB = import("@/types").KnowledgeBase; type Msg = import("@/types").Message;

const EST = "e", PHONE = "5514991234567", OFF = -180, HOJE = "2026-09-14", AMANHA = "2026-09-15";
const lm = (d: string) => { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y!, m! - 1, dd!) - OFF * 60000; };
const at = (d: string, t: string) => { const [h, mi] = t.split(":").map(Number); return lm(d) + (h! * 60 + mi!) * 60000; };
const NOW = at(HOJE, "09:00");
const est = (): Est => ({ id: EST, name: "C", type: "odonto", ownerUid: EST, status: "active", createdAt: 0, bot: { personaName: "L", tone: "", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false } });
const kb = (): KB => ({ establishmentId: EST, about: "", address: null, hours: null, services: [ { name: "Avaliação", priceText: "R$80", durationText: "30 min", description: null }, { name: "Tratamento de Canal", priceText: "R$600", durationText: "30 min", description: null } ], faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0 });
const toolMsg = (name: string, args: Record<string, unknown>, id = `c-${name}`): MM => ({ content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
const appts = (): A[] => [...fakeDb.col(`establishments/${EST}/appointments`).values()] as unknown as A[];
const day = (a: A) => new Date(a.startAt + OFF * 60000).toISOString().slice(0, 10);
const time = (a: A) => new Date(a.startAt + OFF * 60000).toISOString().slice(11, 16);
const mine = () => appts().filter((a) => a.contactPhone.includes("99123"));
async function seed(l: { s: string; d: string; t: string; phone?: string }[]) { for (const a of l) await createAppointment(EST, { contactPhone: a.phone ?? PHONE, contactName: "C", serviceName: a.s, startAt: at(a.d, a.t), durationMin: 30, source: "bot" }); }
async function turn(text: string, history: Msg[], task: CT | null) {
  const intent = detectIntent(text);
  const h = [...history, { id: `c${history.length}`, role: "customer" as const, text, at: NOW }];
  const r = await think({ est: est(), kb: kb(), history: h, contactPhone: PHONE, contactName: "C", customerProfile: null, task, intent });
  const op = r.booked || r.rescheduled || r.cancelled;
  const next = deriveTaskState({ existingTask: task, intent, toolCalls: r.toolCalls, booked: op, statedDate: r.statedDate, statedService: r.statedService });
  const persisted = next && r.pendingCancelAppointmentId ? { ...next, collectedData: { ...next.collectedData, appointmentId: r.pendingCancelAppointmentId } } : next;
  history.push({ id: `c${history.length}`, role: "customer", text, at: NOW });
  history.push({ id: `b${history.length}`, role: "bot", text: r.reply, at: NOW });
  return { task: persisted, ...r };
}
beforeEach(async () => { fakeDb.reset(); vi.setSystemTime(NOW); await saveScheduleConfig(EST, { ...defaultScheduleConfig(EST) }); modelScript = []; });

describe("OT-02H — fluxo de remarcação", () => {
  it("PRINCIPAL: Canal+Avaliação ativos, 'Remarca...avaliação', 10h indisponível, '17' → RESCHEDULE só da Avaliação", async () => {
    await seed([
      { s: "Tratamento de Canal", d: HOJE, t: "15:00" },
      { s: "Avaliação", d: "2026-09-16", t: "09:00" },
      { s: "Avaliação", d: AMANHA, t: "10:00", phone: "5511000000000" }, // bloqueia 10h
    ]);
    const canalId = mine().find((a) => a.serviceName === "Tratamento de Canal")!.id;
    const avalId = mine().find((a) => a.serviceName === "Avaliação")!.id;
    const totalAntes = appts().length;
    const history: Msg[] = [];
    let task: CT | null = { type: "schedule_appointment", state: "offer_options", collectedData: { date: HOJE, serviceName: "Tratamento de Canal" }, missingData: [], updatedAt: NOW };
    modelScript = [toolMsg("find_available_appointments", { date: AMANHA }), { content: "Amanhã: 09,11,13,14,15,16,17. Qual?" }];
    let out = await turn("Remarca tbm pra amanha as 10 avaliação", history, task);
    modelScript = [{ content: "..." }];
    out = await turn("17", history, out.task);

    expect(out.rescheduled).toBe(true);
    expect(out.booked).toBe(false);
    expect(out.reply).toMatch(/remarcad/i);
    expect(out.reply).not.toMatch(/reservad/i);        // não é criação
    expect(out.reply).not.toMatch(/canal/i);
    // nenhum agendamento novo do cliente (RESCHEDULE, não CREATE)
    expect(appts().length).toBe(totalAntes);
    // Canal intacto no lugar original
    const canal = appts().find((a) => a.id === canalId)!;
    expect(canal.serviceName).toBe("Tratamento de Canal");
    expect(day(canal)).toBe(HOJE); expect(canal.status).not.toBe("cancelled");
    // A MESMA Avaliação foi movida para 15/09 17:00
    const aval = appts().find((a) => a.id === avalId)!;
    expect(aval.serviceName).toBe("Avaliação");
    expect(day(aval)).toBe(AMANHA); expect(time(aval)).toBe("17:00");
    // não existe uma Avaliação a mais
    expect(appts().filter((a) => a.serviceName === "Avaliação" && a.contactPhone.includes("99123")).length).toBe(1);
  });

  it("dois agendamentos do MESMO serviço → remarcação continua ambígua (sem escrita)", async () => {
    await seed([{ s: "Avaliação", d: "2026-09-16", t: "09:00" }, { s: "Avaliação", d: "2026-09-17", t: "09:00" }]);
    const task: CT = { type: "reschedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "..." }];
    const out = await turn("as 14", [], task);
    expect(out.rescheduled).toBe(false);
    expect(appts().some((a) => day(a) === AMANHA)).toBe(false);
  });

  it("criação comum continua funcionando", async () => {
    const task: CT = { type: "schedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "..." }];
    const out = await turn("as 11", [], task);
    expect(out.booked).toBe(true);
    expect(mine().find((a) => day(a) === AMANHA)?.serviceName).toBe("Avaliação");
  });

  it("cancelamento continua funcionando", async () => {
    await seed([{ s: "Avaliação", d: AMANHA, t: "10:00" }]);
    const id = mine()[0]!.id;
    const task: CT = { type: "cancel_appointment", state: "confirm", collectedData: { appointmentId: id }, missingData: [], updatedAt: NOW };
    modelScript = [toolMsg("cancel_appointment", { appointmentId: id }), { content: "ok" }];
    const out = await turn("sim", [], task);
    expect(out.cancelled).toBe(true);
    expect(appts().find((a) => a.id === id)?.status).toBe("cancelled");
  });

  it("confirmação de presença continua funcionando", async () => {
    await seed([{ s: "Avaliação", d: AMANHA, t: "10:00" }]);
    const id = mine()[0]!.id;
    modelScript = [toolMsg("confirm_appointment", { appointmentId: id }), { content: "ok" }];
    const out = await turn("confirmo presença", [], null);
    expect(appts().find((a) => a.id === id)?.status).toBe("confirmed");
    expect(out.reply).toMatch(/confirmad/i);
  });

  it("guarda de segunda mutação continua bloqueando", async () => {
    const task: CT = { type: "schedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    modelScript = [toolMsg("create_appointment", { serviceName: "Tratamento de Canal", startAt: at(AMANHA, "16:00") }), { content: "criei os dois" }];
    const out = await turn("as 11", [], task);
    expect(mine().filter((a) => day(a) === AMANHA).length).toBe(1);       // uma escrita só
    expect(mine()[0]!.serviceName).toBe("Avaliação");
    expect(out.reply).toMatch(/reservad|agendad|marcad/i);
  });
});
