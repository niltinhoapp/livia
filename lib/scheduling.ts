// Motor de agenda da Livia: configuração, cálculo de horários livres e
// operações sobre agendamentos.
//
// Fuso: guardamos startAt em epoch UTC. A config tem um offset fixo
// (utcOffsetMinutes; Brasil = -180, sem horário de verão) usado pra converter
// entre o "relógio de parede" local e o epoch. Simples e sem dependências.
import { sub } from "@/lib/firebase/admin";
import type {
  ScheduleConfig,
  DayHours,
  Appointment,
  AppointmentStatus,
} from "@/types";

// ---- Config padrão (Seg-Sex 9-18 com almoço 12-13, Sáb 9-13) ----
export function defaultScheduleConfig(establishmentId: string): ScheduleConfig {
  const weekday: DayHours = {
    open: "09:00",
    close: "18:00",
    breaks: [{ start: "12:00", end: "13:00" }],
  };
  return {
    establishmentId,
    timezone: "America/Sao_Paulo",
    utcOffsetMinutes: -180,
    slotMinutes: 30,
    defaultDurationMin: 30,
    leadHours: 2,
    days: {
      "0": null,
      "1": weekday,
      "2": weekday,
      "3": weekday,
      "4": weekday,
      "5": weekday,
      "6": { open: "09:00", close: "13:00" },
    },
    reminderTemplateName: null,
    reminderTemplateLang: "pt_BR",
    updatedAt: Date.now(),
  };
}

// ---- Helpers de tempo ----
function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function minutesToHM(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// "YYYY-MM-DD" + minutos locais -> epoch UTC, dado o offset local.
export function localToEpoch(dateStr: string, localMinutes: number, offsetMin: number): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const wallAsUtc = Date.UTC(y!, (mo! - 1), d!, 0, 0) + localMinutes * 60000;
  return wallAsUtc - offsetMin * 60000;
}

// Dia da semana (0=domingo) de uma data local.
export function weekdayOf(dateStr: string): number {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay();
}

export interface Slot {
  time: string; // "14:30" (hora local)
  startAt: number; // epoch UTC
}

// Calcula os horários livres de um dia, descontando pausas, antecedência
// mínima e agendamentos já existentes (que se sobrepõem).
export function computeSlots(
  config: ScheduleConfig,
  dateStr: string,
  durationMin: number,
  existing: Appointment[],
  now = Date.now(),
): Slot[] {
  const day = config.days[String(weekdayOf(dateStr))];
  if (!day) return [];

  const open = hmToMinutes(day.open);
  const close = hmToMinutes(day.close);
  const breaks = (day.breaks ?? []).map((b) => ({
    start: hmToMinutes(b.start),
    end: hmToMinutes(b.end),
  }));
  const minStart = now + config.leadHours * 3600000;

  // Ocupados = agendamentos ativos (não cancelados / no_show).
  const busy = existing
    .filter((a) => a.status !== "cancelled" && a.status !== "no_show")
    .map((a) => ({ start: a.startAt, end: a.startAt + a.durationMin * 60000 }));

  const slots: Slot[] = [];
  for (let t = open; t + durationMin <= close; t += config.slotMinutes) {
    const slotEndMin = t + durationMin;
    // dentro de uma pausa?
    if (breaks.some((b) => t < b.end && b.start < slotEndMin)) continue;

    const startAt = localToEpoch(dateStr, t, config.utcOffsetMinutes);
    const endAt = startAt + durationMin * 60000;
    if (startAt < minStart) continue; // respeita antecedência mínima
    if (busy.some((b) => startAt < b.end && b.start < endAt)) continue; // ocupado

    slots.push({ time: minutesToHM(t), startAt });
  }
  return slots;
}

// ---- Persistência: config ----
export async function getScheduleConfig(establishmentId: string): Promise<ScheduleConfig> {
  const doc = await sub(establishmentId, "meta").doc("schedule").get();
  if (doc.exists) return doc.data() as ScheduleConfig;
  return defaultScheduleConfig(establishmentId);
}

export async function saveScheduleConfig(
  establishmentId: string,
  data: Omit<ScheduleConfig, "establishmentId" | "updatedAt">,
): Promise<ScheduleConfig> {
  const cfg: ScheduleConfig = { ...data, establishmentId, updatedAt: Date.now() };
  await sub(establishmentId, "meta").doc("schedule").set(cfg);
  return cfg;
}

// ---- Persistência: agendamentos ----
export async function createAppointment(
  establishmentId: string,
  data: {
    contactPhone: string;
    contactName: string | null;
    serviceName: string;
    startAt: number;
    durationMin: number;
    source: "bot" | "manual";
    note?: string | null;
  },
): Promise<Appointment> {
  const ref = sub(establishmentId, "appointments").doc();
  const appt: Appointment = {
    id: ref.id,
    establishmentId,
    contactPhone: data.contactPhone,
    contactName: data.contactName,
    serviceName: data.serviceName,
    startAt: data.startAt,
    durationMin: data.durationMin,
    status: "pending",
    source: data.source,
    note: data.note ?? null,
    createdAt: Date.now(),
    confirmedAt: null,
    reminderSentAt: null,
  };
  await ref.set(appt);
  return appt;
}

// Agendamentos num intervalo [from, to) (por startAt).
export async function listAppointments(
  establishmentId: string,
  from: number,
  to: number,
): Promise<Appointment[]> {
  const snap = await sub(establishmentId, "appointments")
    .where("startAt", ">=", from)
    .where("startAt", "<", to)
    .orderBy("startAt", "asc")
    .get();
  return snap.docs.map((d) => d.data() as Appointment);
}

export async function getAppointment(
  establishmentId: string,
  id: string,
): Promise<Appointment | null> {
  const doc = await sub(establishmentId, "appointments").doc(id).get();
  return doc.exists ? (doc.data() as Appointment) : null;
}

export async function updateAppointment(
  establishmentId: string,
  id: string,
  patch: Partial<Pick<Appointment, "status" | "startAt" | "durationMin" | "serviceName" | "note" | "confirmedAt" | "reminderSentAt">>,
): Promise<void> {
  await sub(establishmentId, "appointments").doc(id).update(patch);
}

// Agendamentos de UM contato a partir de `from`, em ordem cronológica —
// TODOS os status (o chamador decide o que fazer com cancelados/no-show).
//
// Mesma forma de query de findNextAppointment (igualdade em contactPhone +
// range/orderBy em startAt), de propósito: reaproveita o índice composto que
// já existe e é usado em produção pelo fluxo de lembrete, sem exigir índice
// novo.
//
// É a FONTE DE VERDADE consultada pela ferramenta get_customer_appointments
// (lib/ai/tools.ts) — a Livia nunca deve responder sobre um agendamento a
// partir da memória da conversa.
export async function listCustomerAppointments(
  establishmentId: string,
  contactPhone: string,
  from: number,
  limitCount = 10,
): Promise<Appointment[]> {
  const snap = await sub(establishmentId, "appointments")
    .where("contactPhone", "==", contactPhone)
    .where("startAt", ">=", from)
    .orderBy("startAt", "asc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Appointment);
}

// Próximo agendamento ativo do contato (o mais cedo a partir de agora).
export async function findNextAppointment(
  establishmentId: string,
  contactPhone: string,
  now = Date.now(),
): Promise<Appointment | null> {
  const snap = await sub(establishmentId, "appointments")
    .where("contactPhone", "==", contactPhone)
    .where("startAt", ">=", now)
    .orderBy("startAt", "asc")
    .limit(3)
    .get();
  const found = snap.docs
    .map((d) => d.data() as Appointment)
    .find((a) => a.status === "pending" || a.status === "confirmed");
  return found ?? null;
}

// Existe algum agendamento ATIVO que conflita com [startAt, startAt+duration)?
// Consulta uma janela generosa (48h) em torno do horário candidato — os
// únicos agendamentos que podem colidir estão nela, dado que durações são
// sempre de poucas horas. Usado tanto pelo tool de agendamento/remarcação da
// IA (lib/ai/tools.ts) quanto pelas rotas do painel — centralizado aqui pra
// não reimplementar a mesma checagem em cada lugar que cria/remarca.
// `excludeId` evita que um agendamento colida "consigo mesmo" ao remarcar.
export async function hasScheduleConflict(
  establishmentId: string,
  startAt: number,
  durationMin: number,
  excludeId?: string,
): Promise<boolean> {
  const existing = await listAppointments(establishmentId, startAt - 24 * 3600000, startAt + 48 * 3600000);
  return existing.some(
    (a) =>
      a.id !== excludeId &&
      a.status !== "cancelled" &&
      a.status !== "no_show" &&
      startAt < a.startAt + a.durationMin * 60000 &&
      a.startAt < startAt + durationMin * 60000,
  );
}

export function setStatus(
  establishmentId: string,
  id: string,
  status: AppointmentStatus,
): Promise<void> {
  const patch: Record<string, unknown> = { status };
  if (status === "confirmed") patch.confirmedAt = Date.now();
  // Única fonte de "quando foi cancelado" — sem isto, o painel diário
  // (Passo 13) não teria como mostrar "cancelamentos hoje" com dado real; a
  // alternativa seria inventar/aproximar, que é exatamente o que não pode
  // acontecer.
  if (status === "cancelled") patch.cancelledAt = Date.now();
  return updateAppointment(establishmentId, id, patch as Partial<Appointment>);
}

// ---- Consultas por intervalo de data (Passo 13 — painel diário) ----
// Range de campo único (createdAt / cancelledAt), sem combinar com outra
// igualdade — não precisa de índice composto, só o índice de campo único que
// o Firestore já mantém sozinho. `limit` é generoso o bastante pro volume
// diário de um único estabelecimento; existe só pra nunca ser ilimitado.
export async function listAppointmentsCreatedSince(
  establishmentId: string,
  since: number,
  limitCount = 500,
): Promise<Appointment[]> {
  const snap = await sub(establishmentId, "appointments")
    .where("createdAt", ">=", since)
    .orderBy("createdAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Appointment);
}

export async function listAppointmentsCancelledSince(
  establishmentId: string,
  since: number,
  limitCount = 500,
): Promise<Appointment[]> {
  const snap = await sub(establishmentId, "appointments")
    .where("cancelledAt", ">=", since)
    .orderBy("cancelledAt", "desc")
    .limit(limitCount)
    .get();
  return snap.docs.map((d) => d.data() as Appointment);
}
