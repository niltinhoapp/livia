// Motor de agenda da Livia: configuração, cálculo de horários livres e
// operações sobre agendamentos.
//
// Fuso: guardamos startAt em epoch UTC. A config tem um offset fixo
// (utcOffsetMinutes; Brasil = -180, sem horário de verão) usado pra converter
// entre o "relógio de parede" local e o epoch. Simples e sem dependências.
import { sub } from "@/lib/firebase/admin";
import { normalizePhone } from "@/lib/whatsapp/client";
import type {
  ScheduleConfig,
  DayHours,
  Appointment,
  AppointmentStatus,
  KnowledgeService,
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

// Motivo pelo qual um horário NÃO é reservável. `null` = reservável.
export type NotBookableReason =
  | "closed_day" // estabelecimento não abre nesse dia
  | "outside_hours" // fora do expediente (ou não cabe até o fechamento)
  | "during_break" // dentro de uma pausa (almoço)
  | "too_soon" // viola a antecedência mínima (leadHours)
  | "overlap"; // colide com um agendamento ativo

// ---- REGRA ÚNICA DE "SLOT RESERVÁVEL" ----
//
// Esta é a ÚNICA definição de horário reservável do sistema. A listagem
// (computeSlots) e a criação (assertBookable) chamam exatamente esta função,
// com a mesma duração resolvida pelo backend — foi a divergência entre as
// duas que fez a Livia oferecer horários que a criação recusava, e que
// deixava a criação aceitar horários que a listagem jamais ofereceria
// (dentro da pausa, fora do expediente, sem antecedência mínima).
//
// Considera: expediente, pausa, leadHours, sobreposição, status bloqueantes,
// duração real e timezone (via localToEpoch/utcOffsetMinutes na conversão
// feita por quem chama).
export function slotBookability(
  config: ScheduleConfig,
  startAt: number,
  durationMin: number,
  existing: Appointment[],
  now = Date.now(),
  // Remarcação: o próprio agendamento não pode colidir consigo mesmo.
  excludeId?: string,
): NotBookableReason | null {
  // Instante -> "relógio de parede" local, para comparar com expediente/pausa.
  const local = new Date(startAt + config.utcOffsetMinutes * 60000);
  const dateStr = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}`;
  const day = config.days[String(weekdayOf(dateStr))];
  if (!day) return "closed_day";

  const startMin = local.getUTCHours() * 60 + local.getUTCMinutes();
  const endMin = startMin + durationMin;
  if (startMin < hmToMinutes(day.open) || endMin > hmToMinutes(day.close)) return "outside_hours";

  const breaks = (day.breaks ?? []).map((b) => ({ start: hmToMinutes(b.start), end: hmToMinutes(b.end) }));
  if (breaks.some((b) => startMin < b.end && b.start < endMin)) return "during_break";

  if (startAt < now + config.leadHours * 3600000) return "too_soon";

  const endAt = startAt + durationMin * 60000;
  const colide = existing.some(
    (a) => a.id !== excludeId && isActive(a) && startAt < a.startAt + a.durationMin * 60000 && a.startAt < endAt,
  );
  return colide ? "overlap" : null;
}

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

  const slots: Slot[] = [];
  for (let t = open; t + durationMin <= close; t += config.slotMinutes) {
    const startAt = localToEpoch(dateStr, t, config.utcOffsetMinutes);
    // Um horário só entra na lista se a MESMA regra usada na criação disser
    // que ele é reservável agora.
    if (slotBookability(config, startAt, durationMin, existing, now) !== null) continue;
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
    // Identidade canônica do contato (mesma forma já usada como doc id de
    // Conversation e CustomerProfile em lib/repo.ts). É o ÚNICO ponto de
    // criação de agendamento do sistema — tanto a ferramenta da IA
    // (lib/ai/tools.ts) quanto a agenda manual do painel
    // (app/api/appointments/route.ts) passam por aqui —, então normalizar
    // aqui fecha a divergência inteira sem tocar nos chamadores.
    //
    // Antes: a IA gravava `msg.from` cru e o painel gravava exatamente o que
    // o dono digitasse ("(14) 99123-4567"), enquanto TODA leitura consultava
    // com normalizePhone(). Um agendamento real ficava invisível para a
    // Lívia, que respondia ao cliente que ele não tinha horário marcado.
    contactPhone: normalizePhone(data.contactPhone),
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
  return findCustomerAppointments(establishmentId, contactPhone, from, () => true, limitCount);
}

// Só os agendamentos ATIVOS do contato. É esta que a ferramenta
// get_customer_appointments (lib/ai/tools.ts) usa: com listCustomerAppointments
// ela recebia 10 documentos de qualquer status e filtrava depois, então 10
// cancelamentos escondiam um agendamento ativo — o mesmo bug do limit, um
// nível acima. Aqui o filtro entra ANTES do limite valer.
export async function listActiveCustomerAppointments(
  establishmentId: string,
  contactPhone: string,
  from: number,
  limitCount = 10,
): Promise<Appointment[]> {
  return findCustomerAppointments(establishmentId, contactPhone, from, isActive, limitCount);
}

// Próximo agendamento ativo do contato (o mais cedo a partir de agora).
export async function findNextAppointment(
  establishmentId: string,
  contactPhone: string,
  now = Date.now(),
): Promise<Appointment | null> {
  const found = await findCustomerAppointments(establishmentId, contactPhone, now, isActive, 1);
  return found[0] ?? null;
}

// ---- Busca por contato com filtro de status APÓS a query ----
//
// O bug corrigido aqui: a query pedia `limit(3)` / `limit(10)` e o filtro de
// status (`pending|confirmed`, ou "não cancelado") era aplicado depois, em
// memória. Três cancelamentos seguidos consumiam o limit inteiro e a função
// devolvia "nenhum agendamento ativo" com um agendamento ativo existindo na
// agenda — a Lívia então dizia ao cliente que ele não tinha horário marcado.
//
// A correção pagina: continua lendo páginas seguintes enquanto não juntou os
// `want` documentos que interessam. O custo segue limitado (PAGE_SIZE ×
// MAX_PAGES documentos no pior caso) e a query é EXATAMENTE a mesma de
// antes — mesma igualdade + range + orderBy —, então nenhum índice novo é
// necessário.
//
// Não usa `where("status", "in", [...])` de propósito: isso resolveria no
// servidor, mas exigiria um índice composto novo (contactPhone + status +
// startAt) que não existe hoje, e a consulta quebraria em produção até o
// índice terminar de construir.
const PAGE_SIZE = 25;
const MAX_PAGES = 4;

export function isActive(a: Appointment): boolean {
  return a.status !== "cancelled" && a.status !== "no_show";
}

// ---- Compatibilidade com documentos legados ----
//
// Agendamentos criados ANTES da normalização acima podem ter contactPhone em
// qualquer formato ("(14) 99123-4567", "14991234567", "+55 14 99123-4567").
// Nenhuma query de igualdade consegue encontrá-los a partir do telefone
// canônico — a forma original não é reconstruível.
//
// Fallback: quando a query canônica não acha NADA, varre uma janela de datas
// limitada dos agendamentos do próprio estabelecimento (mesmo índice de
// campo único que listAppointments já usa, sem índice novo) e compara por
// telefone normalizado em memória. Roda só no caso vazio, que é exatamente a
// falha perigosa ("você não tem nenhum horário marcado" com horário real na
// agenda); assim o custo extra não entra no caminho normal.
//
// Limitação conhecida e aceita nesta etapa: um cliente com um agendamento
// canônico E outro legado recebe só o canônico (a query não vem vazia, então
// o fallback não dispara). A migração documentada em
// docs/migracao-telefone.md elimina o caso; depois dela, este fallback pode
// ser desligado com LIVIA_LEGACY_PHONE_SCAN=off.
const LEGACY_SCAN_HORIZON_MS = 180 * 24 * 3600000;
const LEGACY_SCAN_LIMIT = 300;

async function scanLegacyCustomerAppointments(
  establishmentId: string,
  contactPhone: string,
  from: number,
  keep: (a: Appointment) => boolean,
  want: number,
): Promise<Appointment[]> {
  if (process.env.LIVIA_LEGACY_PHONE_SCAN === "off") return [];
  const key = normalizePhone(contactPhone);

  const snap = await sub(establishmentId, "appointments")
    .where("startAt", ">=", from)
    .where("startAt", "<", from + LEGACY_SCAN_HORIZON_MS)
    .orderBy("startAt", "asc")
    .limit(LEGACY_SCAN_LIMIT)
    .get();

  const out: Appointment[] = [];
  for (const d of snap.docs) {
    if (out.length >= want) break;
    const a = d.data() as Appointment;
    // A query já está sob establishments/{id}/appointments — o isolamento
    // por estabelecimento vem do caminho, não deste filtro.
    if (normalizePhone(a.contactPhone) !== key) continue;
    if (keep(a)) out.push(a);
  }
  return out;
}

async function findCustomerAppointments(
  establishmentId: string,
  contactPhone: string,
  from: number,
  keep: (a: Appointment) => boolean,
  want: number,
): Promise<Appointment[]> {
  const canonical = await queryCustomerAppointments(establishmentId, contactPhone, from, keep, want);
  if (canonical.length > 0) return canonical;
  return scanLegacyCustomerAppointments(establishmentId, contactPhone, from, keep, want);
}

async function queryCustomerAppointments(
  establishmentId: string,
  contactPhone: string,
  from: number,
  keep: (a: Appointment) => boolean,
  want: number,
): Promise<Appointment[]> {
  const base = sub(establishmentId, "appointments")
    .where("contactPhone", "==", contactPhone)
    .where("startAt", ">=", from)
    .orderBy("startAt", "asc");

  const out: Appointment[] = [];
  let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  for (let page = 0; page < MAX_PAGES && out.length < want; page++) {
    const q: FirebaseFirestore.Query = cursor ? base.startAfter(cursor) : base;
    const snap = await q.limit(PAGE_SIZE).get();
    if (snap.docs.length === 0) break;

    for (const d of snap.docs) {
      if (out.length >= want) break;
      const a = d.data() as Appointment;
      if (keep(a)) out.push(a);
    }

    if (snap.docs.length < PAGE_SIZE) break; // acabaram os documentos
    cursor = snap.docs[snap.docs.length - 1]!;
  }

  return out;
}

// Existe algum agendamento ATIVO que conflita com [startAt, startAt+duration)?
// Consulta uma janela generosa (48h) em torno do horário candidato — os
// únicos agendamentos que podem colidir estão nela, dado que durações são
// sempre de poucas horas. Usado tanto pelo tool de agendamento/remarcação da
// IA (lib/ai/tools.ts) quanto pelas rotas do painel — centralizado aqui pra
// não reimplementar a mesma checagem em cada lugar que cria/remarca.
// `excludeId` evita que um agendamento colida "consigo mesmo" ao remarcar.
// ---- DURAÇÃO: autoridade do BACKEND ----
//
// O modelo pode identificar QUAL serviço o cliente quer, mas nunca quantos
// minutos ele dura — era isso que permitia listar horários com 60min e
// validar a criação com 30min (ou vice-versa), fazendo as duas contas
// discordarem.
//
// Limitação conhecida e deliberada: hoje não existe catálogo de serviços com
// duração estruturada. `KnowledgeService.durationText` é texto livre ("40
// min", "1h"), preenchido pelo comerciante. Interpretamos esse texto quando
// ele é claro e caímos em `config.defaultDurationMin` quando não é — sem
// criar um módulo de serviços novo. Duração individual confiável por serviço
// fica para o roadmap.
export function parseDurationText(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.trim().toLowerCase();

  // "1:30"
  const relogio = t.match(/^(\d{1,2}):(\d{2})$/);
  if (relogio) return dentroDaFaixa(Number(relogio[1]) * 60 + Number(relogio[2]));

  // "1h30", "1 h 30", "1h30min" — horas seguidas de minutos soltos. Precisa
  // vir antes da leitura isolada de horas, senão "1h30" viraria só 60.
  const horaEMinuto = t.match(/(\d+)\s*h(?:oras?)?\s*(\d{1,2})/);
  if (horaEMinuto) return dentroDaFaixa(Number(horaEMinuto[1]) * 60 + Number(horaEMinuto[2]));

  let total = 0;
  const horas = t.match(/(\d+)\s*(h|hora)/);
  const minutos = t.match(/(\d+)\s*(min|minuto)/);
  if (horas) total += Number(horas[1]) * 60;
  if (minutos) total += Number(minutos[1]);

  // Só um número solto ("40") — assume minutos.
  if (!total) {
    const solto = t.match(/^(\d{1,3})$/);
    if (solto) total = Number(solto[1]);
  }
  return dentroDaFaixa(total);
}

function dentroDaFaixa(min: number): number | null {
  return min > 0 && min <= 8 * 60 ? min : null;
}

// Comparação de nome de serviço tolerante: o cliente (e o modelo) escrevem
// "avaliacao" para um serviço cadastrado como "Avaliação".
function chaveServico(nome: string): string {
  return nome
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function resolveServiceDuration(
  config: ScheduleConfig,
  services: KnowledgeService[] | undefined,
  serviceName: string | undefined,
): number {
  if (serviceName && services?.length) {
    const alvo = chaveServico(serviceName);
    const achado =
      services.find((s) => chaveServico(s.name) === alvo) ??
      services.find((s) => chaveServico(s.name).includes(alvo) || alvo.includes(chaveServico(s.name)));
    const parsed = parseDurationText(achado?.durationText);
    if (parsed) return parsed;
  }
  return config.defaultDurationMin;
}

// Validação FINAL no momento da criação. Relê a agenda (protege contra
// concorrência real: alguém pode ter reservado entre a listagem e a escolha)
// e aplica exatamente a mesma regra da listagem.
export async function assertBookable(
  establishmentId: string,
  config: ScheduleConfig,
  startAt: number,
  durationMin: number,
  now = Date.now(),
  excludeId?: string,
): Promise<NotBookableReason | null> {
  const existing = await listAppointments(establishmentId, startAt - 24 * 3600000, startAt + 48 * 3600000);
  return slotBookability(config, startAt, durationMin, existing, now, excludeId);
}

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
