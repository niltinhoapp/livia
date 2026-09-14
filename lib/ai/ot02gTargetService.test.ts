// Regressão OT-02G: uma seleção de horário não pode aplicar a mutação a um
// serviço preso de um fluxo anterior. Integração real: think() +
// deriveTaskState() + tools + scheduling, com o Firestore falso do projeto.
// Só o modelo (OpenAI) é roteirizado, espelhando as tool calls do transcript.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => {
  const fake = await import("@/lib/__testing__/firestoreFake");
  return { sub: fake.sub, establishmentRef: fake.establishmentRef, db: fake.fakeDb };
});

type MM = { content: string | null; tool_calls?: unknown[] };
let modelScript: MM[] = [];
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: async () => ({ choices: [{ message: modelScript.shift() ?? { content: "ok" } }] }) } };
  },
}));

import { fakeDb } from "@/lib/__testing__/firestoreFake";
import { think } from "@/lib/ai/brain";
import { detectIntent } from "@/lib/ai/intent";
import { deriveTaskState } from "@/lib/ai/taskState";
import { createAppointment, saveScheduleConfig, defaultScheduleConfig } from "@/lib/scheduling";
import type { Appointment, ConversationTask, Establishment, KnowledgeBase, Message } from "@/types";

const EST = "est_odonto";
const PHONE = "5514991234567";
const OFFSET = -180;
const HOJE = "2026-09-14";
const AMANHA = "2026-09-15";

function localMidnight(d: string): number { const [y, m, dd] = d.split("-").map(Number); return Date.UTC(y!, m! - 1, dd!) - OFFSET * 60000; }
function at(d: string, hhmm: string): number { const [h, mi] = hhmm.split(":").map(Number); return localMidnight(d) + (h! * 60 + mi!) * 60000; }
const NOW = at(HOJE, "09:00");

function est(): Establishment {
  return { id: EST, name: "Clínica", type: "odonto", ownerUid: EST, status: "active", createdAt: 0,
    bot: { personaName: "Lívia", tone: "", bookingEnabled: true, handoffKeywords: [], medicalGuardrail: false } };
}
function kb(): KnowledgeBase {
  return { establishmentId: EST, about: "", address: null, hours: null,
    services: [ { name: "Avaliação", priceText: "R$ 80", durationText: "30 min", description: null },
                { name: "Tratamento de Canal", priceText: "R$ 600", durationText: "30 min", description: null } ],
    faqs: [], notes: null, paymentMethods: null, importantInfo: null, toneGuidelines: null, prohibitions: null, handoffTriggers: null, updatedAt: 0 };
}
const tool = (name: string, args: Record<string, unknown>, id = `c-${name}`): MM => ({ content: null, tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }] });
function appts(): Appointment[] { return [...fakeDb.col(`establishments/${EST}/appointments`).values()] as unknown as Appointment[]; }
function dayOf(a: Appointment): string { return new Date(a.startAt + OFFSET * 60000).toISOString().slice(0, 10); }
function timeOf(a: Appointment): string { return new Date(a.startAt + OFFSET * 60000).toISOString().slice(11, 16); }

async function webhookTurn(text: string, history: Message[], task: ConversationTask | null) {
  const intent = detectIntent(text);
  const historyForAI = [...history, { id: `c${history.length}`, role: "customer" as const, text, at: NOW }];
  const r = await think({ est: est(), kb: kb(), history: historyForAI, contactPhone: PHONE, contactName: "Cliente", customerProfile: null, task, intent });
  const op = r.booked || r.rescheduled || r.cancelled;
  const next = deriveTaskState({ existingTask: task, intent, toolCalls: r.toolCalls, booked: op, statedDate: r.statedDate, statedService: r.statedService });
  const persisted = next && r.pendingCancelAppointmentId ? { ...next, collectedData: { ...next.collectedData, appointmentId: r.pendingCancelAppointmentId } } : next;
  history.push({ id: `c${history.length}`, role: "customer", text, at: NOW });
  history.push({ id: `b${history.length}`, role: "bot", text: r.reply, at: NOW });
  return { task: persisted, ...r };
}

async function seed(list: { s: string; d: string; t: string; phone?: string }[]) {
  for (const a of list) {
    await createAppointment(EST, { contactPhone: a.phone ?? PHONE, contactName: "Cliente", serviceName: a.s, startAt: at(a.d, a.t), durationMin: 30, source: "bot" });
  }
}

beforeEach(async () => {
  fakeDb.reset();
  vi.setSystemTime(NOW);
  await saveScheduleConfig(EST, { ...defaultScheduleConfig(EST) });
});

// Estado inicial real do transcript: tarefa em andamento com serviço preso
// (Canal), agenda com Canal e Avaliação, e 10:00 de amanhã bloqueado.
async function transcriptSetup(): Promise<{ history: Message[]; task: ConversationTask }> {
  await seed([
    { s: "Tratamento de Canal", d: HOJE, t: "15:00" },
    { s: "Avaliação", d: "2026-09-16", t: "09:00" },
    { s: "Avaliação", d: AMANHA, t: "10:00", phone: "5511000000000" }, // bloqueia 10:00
  ]);
  return {
    history: [],
    task: { type: "schedule_appointment", state: "offer_options", collectedData: { date: HOJE, serviceName: "Tratamento de Canal" }, missingData: [], updatedAt: NOW },
  };
}

function canalCriadoEm(dia: string): Appointment | undefined {
  return appts().find((a) => a.serviceName === "Tratamento de Canal" && dayOf(a) === dia && a.contactPhone.includes("99123"));
}

describe("OT-02G — seleção de horário respeita o serviço dito, não o preso", () => {
  it("1. transcript exato: 'avaliação' → alternativas → 'As 17' NÃO cria Canal", async () => {
    const { history, task } = await transcriptSetup();
    modelScript = [tool("find_available_appointments", { date: AMANHA }), { content: "Para amanhã: 09:00, 11:00, 13:00, 14:00, 15:00, 16:00, 17:00. Qual prefere?" }];
    let out = await webhookTurn("Remarca tbm pra amanha as 10 avaliação", history, task);
    modelScript = [{ content: "..." }];
    out = await webhookTurn("As 17", history, out.task);
    expect(canalCriadoEm(AMANHA)).toBeUndefined();          // NÃO criou Canal
    expect(out.reply).not.toMatch(/canal/i);                 // não fala de Canal
    // Se houve mutação, foi de Avaliação (o serviço que o cliente nomeou).
    const novo = appts().find((a) => dayOf(a) === AMANHA && a.contactPhone.includes("99123") && timeOf(a) === "17:00");
    if (novo) expect(novo.serviceName).toBe("Avaliação");
  });

  it("2. serviço anterior (Canal) não contamina quando o cliente diz 'avaliação' + horário livre", async () => {
    await seed([{ s: "Tratamento de Canal", d: HOJE, t: "15:00" }]);
    const task: ConversationTask = { type: "schedule_appointment", state: "offer_options", collectedData: { date: HOJE, serviceName: "Tratamento de Canal" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "ok" }];
    const out = await webhookTurn("quero avaliação amanhã as 11", [], task);
    expect(canalCriadoEm(AMANHA)).toBeUndefined();
    const criado = appts().find((a) => dayOf(a) === AMANHA);
    expect(criado?.serviceName).toBe("Avaliação");
    expect(out.booked).toBe(true);
  });

  it.each(["17", "17h", "às 17", "pode ser 17"])("3-5. resposta curta '%s' mantém o alvo Avaliação (não vira Canal)", async (resp) => {
    const { history } = await transcriptSetup();
    // tarefa já corrigida para Avaliação (como fica após o turno 'avaliação')
    const task: ConversationTask = { type: "schedule_appointment", state: "confirm", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "..." }];
    const out = await webhookTurn(resp, history, task);
    expect(canalCriadoEm(AMANHA)).toBeUndefined();
    const novo = appts().find((a) => dayOf(a) === AMANHA && a.contactPhone.includes("99123"));
    expect(novo?.serviceName).toBe("Avaliação");
    expect(out.reply).not.toMatch(/canal/i);
  });

  it("6. dois agendamentos do mesmo serviço ainda exigem desambiguação na remarcação", async () => {
    await seed([{ s: "Limpeza", d: "2026-09-16", t: "09:00" }, { s: "Limpeza", d: "2026-09-17", t: "09:00" }]);
    const task: ConversationTask = { type: "reschedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Limpeza" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "..." }];
    const out = await webhookTurn("as 14", [], task);
    // Nenhuma remarcação silenciosa: reschedule sem appointmentId com 2 ativos é ambíguo.
    expect(out.rescheduled).toBe(false);
    const movidos = appts().filter((a) => dayOf(a) === AMANHA && a.status !== "cancelled");
    expect(movidos.length).toBe(0);
  });

  it("7. primeiro horário indisponível não provoca mutação", async () => {
    await seed([{ s: "Avaliação", d: AMANHA, t: "10:00", phone: "5511000000000" }]);
    const task: ConversationTask = { type: "schedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "..." }];
    const out = await webhookTurn("as 10", [], task);
    expect(out.booked).toBe(false);
    // nenhum agendamento do cliente criado às 10:00
    expect(appts().some((a) => a.contactPhone.includes("99123") && dayOf(a) === AMANHA)).toBe(false);
  });

  it("8. só após escolha válida ocorre a mutação (Avaliação, horário livre)", async () => {
    const task: ConversationTask = { type: "schedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    modelScript = [{ content: "..." }];
    const out = await webhookTurn("as 11", [], task);
    expect(out.booked).toBe(true);
    const criado = appts().find((a) => dayOf(a) === AMANHA && a.contactPhone.includes("99123"));
    expect(criado?.serviceName).toBe("Avaliação");
    expect(timeOf(criado!)).toBe("11:00");
  });

  it("9. segunda mutação no mesmo turno continua bloqueada (guarda #38-#40)", async () => {
    const task: ConversationTask = { type: "schedule_appointment", state: "offer_options", collectedData: { date: AMANHA, serviceName: "Avaliação" }, missingData: [], updatedAt: NOW };
    // pré-loop cria Avaliação 11:00; o modelo tenta um segundo create — deve ser bloqueado
    modelScript = [tool("create_appointment", { serviceName: "Tratamento de Canal", startAt: at(AMANHA, "16:00") }), { content: "criei os dois" }];
    const out = await webhookTurn("as 11", [], task);
    const doCliente = appts().filter((a) => a.contactPhone.includes("99123") && dayOf(a) === AMANHA);
    expect(doCliente.length).toBe(1);                 // só UMA escrita
    expect(doCliente[0]!.serviceName).toBe("Avaliação");
    expect(out.reply).toMatch(/reservad|agendad|marcad/i);
  });
});
