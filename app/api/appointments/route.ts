// GET  /api/appointments?from=<epoch>&to=<epoch>  -> lista no intervalo
// POST /api/appointments  -> cria agendamento (valida horário livre)
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import {
  getScheduleConfig,
  listAppointments,
  computeSlots,
  createAppointment,
} from "@/lib/scheduling";

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const now = Date.now();
  const from = Number(req.nextUrl.searchParams.get("from")) || now;
  const to = Number(req.nextUrl.searchParams.get("to")) || now + 30 * 24 * 3600000;
  return NextResponse.json({ appointments: await listAppointments(id, from, to) });
}

export async function POST(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const b = (await req.json().catch(() => null)) as {
    contactPhone?: string;
    contactName?: string | null;
    serviceName?: string;
    startAt?: number;
    durationMin?: number;
    source?: "bot" | "manual";
    note?: string | null;
  } | null;

  if (!b?.contactPhone || !b.serviceName || typeof b.startAt !== "number") {
    return NextResponse.json(
      { error: "contactPhone, serviceName e startAt são obrigatórios" },
      { status: 400 },
    );
  }

  const config = await getScheduleConfig(id);
  const durationMin = b.durationMin ?? config.defaultDurationMin;

  // Revalida no servidor que o horário ainda está livre (evita corrida).
  const dayStart = b.startAt - (b.startAt % (24 * 3600000));
  const existing = await listAppointments(id, dayStart - 24 * 3600000, dayStart + 48 * 3600000);
  const clash = existing.some(
    (a) =>
      a.status !== "cancelled" &&
      a.status !== "no_show" &&
      b.startAt! < a.startAt + a.durationMin * 60000 &&
      a.startAt < b.startAt! + durationMin * 60000,
  );
  if (clash) {
    return NextResponse.json({ error: "horário indisponível" }, { status: 409 });
  }

  const appt = await createAppointment(id, {
    contactPhone: b.contactPhone,
    contactName: b.contactName ?? null,
    serviceName: b.serviceName,
    startAt: b.startAt,
    durationMin,
    source: b.source ?? "manual",
    note: b.note ?? null,
  });
  return NextResponse.json({ appointment: appt });
}
