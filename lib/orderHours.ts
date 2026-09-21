import type { DayHours, OrderHoursConfig, OrderSettings, ScheduleConfig } from "@/types";

export type OrderHoursSource = "order_hours" | "business_hours";
export interface LocalOpening { date: string; time: string; }
export type OrderHoursAvailability = { open: true; source: OrderHoursSource } | { open: false; source: OrderHoursSource; nextOpening: LocalOpening | null };

const HOUR = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAY_KEYS = ["0", "1", "2", "3", "4", "5", "6"] as const;
export function isHour(value: unknown): value is string { return typeof value === "string" && HOUR.test(value); }
export function toMinutes(value: string): number { const [hour, minute] = value.split(":").map(Number); return hour! * 60 + minute!; }
export function weekdayOf(date: string): number { const [year, month, day] = date.split("-").map(Number); return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay(); }
function addDays(date: string, days: number): string { const [year, month, day] = date.split("-").map(Number); const next = new Date(Date.UTC(year!, month! - 1, day! + days)); return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`; }
function ordinal(date: string): number { const [year, month, day] = date.split("-").map(Number); return Math.floor(Date.UTC(year!, month! - 1, day!) / 86_400_000); }

function localAt(at: number, schedule: ScheduleConfig): LocalOpening & { minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: schedule.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
    const value = (kind: string) => parts.find((part) => part.type === kind)?.value;
    const [year, month, day, hour, minute] = [value("year"), value("month"), value("day"), value("hour"), value("minute")];
    if (year && month && day && hour && minute) return { date: `${year}-${month}-${day}`, time: `${hour}:${minute}`, minute: Number(hour) * 60 + Number(minute) };
  } catch { /* configuração legado inválida: conserva o offset canônico existente */ }
  const date = new Date(at + schedule.utcOffsetMinutes * 60_000);
  return { date: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`, time: `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`, minute: date.getUTCHours() * 60 + date.getUTCMinutes() };
}

interface Interval { start: number; end: number; breaks: Array<{ start: number; end: number }>; }
function intervalFor(date: string, hours: DayHours | null | undefined): Interval | null {
  if (!hours || !isHour(hours.open) || !isHour(hours.close)) return null;
  const open = toMinutes(hours.open), rawClose = toMinutes(hours.close); if (open === rawClose) return null;
  const close = rawClose <= open ? rawClose + 1440 : rawClose;
  const pauses = (hours.breaks ?? []).flatMap((pause) => {
    if (!isHour(pause.start) || !isHour(pause.end)) return [];
    let start = toMinutes(pause.start), end = toMinutes(pause.end);
    if (start < open) start += 1440;
    if (end <= start) end += 1440;
    return start >= open && end <= close && start < end ? [{ start, end }] : [];
  });
  const base = ordinal(date) * 1440;
  return { start: base + open, end: base + close, breaks: pauses.map((pause) => ({ start: base + pause.start, end: base + pause.end })) };
}
function selectedHours(settings: OrderSettings, schedule: ScheduleConfig): { days: Record<string, DayHours | null>; source: OrderHoursSource } { return settings.orderHours ? { days: settings.orderHours.days, source: "order_hours" } : { days: schedule.days, source: "business_hours" }; }

export function nextOrderOpening(settings: OrderSettings, schedule: ScheduleConfig, at = Date.now()): LocalOpening | null {
  const local = localAt(at, schedule), selected = selectedHours(settings, schedule), now = ordinal(local.date) * 1440 + local.minute;
  for (let offset = 0; offset <= 8; offset += 1) {
    const date = addDays(local.date, offset), interval = intervalFor(date, selected.days[String(weekdayOf(date))]); if (!interval) continue;
    let cursor = interval.start;
    for (const pause of interval.breaks) {
      if (cursor > now) return { date: addDays("1970-01-01", Math.floor(cursor / 1440)), time: `${String(Math.floor((cursor % 1440) / 60)).padStart(2, "0")}:${String(cursor % 60).padStart(2, "0")}` };
      cursor = pause.end;
    }
    if (cursor > now) return { date: addDays("1970-01-01", Math.floor(cursor / 1440)), time: `${String(Math.floor((cursor % 1440) / 60)).padStart(2, "0")}:${String(cursor % 60).padStart(2, "0")}` };
  }
  return null;
}

export function orderHoursAvailability(settings: OrderSettings, schedule: ScheduleConfig, at = Date.now()): OrderHoursAvailability {
  const local = localAt(at, schedule), selected = selectedHours(settings, schedule), now = ordinal(local.date) * 1440 + local.minute;
  for (const date of [addDays(local.date, -1), local.date]) {
    const interval = intervalFor(date, selected.days[String(weekdayOf(date))]);
    if (interval && now >= interval.start && now < interval.end && !interval.breaks.some((pause) => now >= pause.start && now < pause.end)) return { open: true, source: selected.source };
  }
  return { open: false, source: selected.source, nextOpening: nextOrderOpening(settings, schedule, at) };
}

export function normalizeOrderHours(input: unknown): OrderHoursConfig | null {
  if (input === null || input === undefined) return null;
  if (!input || typeof input !== "object" || !(input as { days?: unknown }).days || typeof (input as { days: unknown }).days !== "object") throw new Error("Horário de pedidos inválido.");
  const raw = (input as { days: Record<string, unknown> }).days, days: Record<string, DayHours | null> = {};
  for (const key of DAY_KEYS) {
    const value = raw[key]; if (value === null) { days[key] = null; continue; }
    if (!value || typeof value !== "object") throw new Error(`Horário de pedidos inválido para o dia ${key}.`);
    const current = value as Partial<DayHours>; if (!isHour(current.open) || !isHour(current.close) || current.open === current.close) throw new Error(`Abertura e fechamento inválidos para o dia ${key}.`);
    const interval = intervalFor("2026-01-05", { open: current.open, close: current.close, breaks: current.breaks });
    if ((current.breaks?.length ?? 0) !== (interval?.breaks.length ?? 0)) throw new Error(`Pausa inválida para o dia ${key}.`);
    const pauses = [...(interval?.breaks ?? [])].sort((a, b) => a.start - b.start);
    if (pauses.some((pause, index) => index > 0 && pause.start < pauses[index - 1]!.end)) throw new Error(`Pausas sobrepostas para o dia ${key}.`);
    days[key] = { open: current.open, close: current.close, ...(current.breaks?.length ? { breaks: current.breaks.map((pause) => ({ start: pause.start, end: pause.end })) } : {}) };
  }
  return { days };
}
