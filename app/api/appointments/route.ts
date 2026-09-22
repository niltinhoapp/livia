// GET  /api/appointments?from=<epoch>&to=<epoch>  -> lista no intervalo
// POST /api/appointments  -> cria agendamento (valida horário livre)
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { logError } from "@/lib/observability";
import {
  getScheduleConfig,
  listAppointments,
  computeSlots,
  bookAppointment,
  AppointmentConflictError,
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

  try {
    const config = await getScheduleConfig(id);
    const durationMin = b.durationMin ?? config.defaultDurationMin;

    const appt = await bookAppointment(id, config, {
      contactPhone: b.contactPhone,
      contactName: b.contactName ?? null,
      serviceName: b.serviceName,
      startAt: b.startAt,
      durationMin,
      source: b.source ?? "manual",
      note: b.note ?? null,
    });
    return NextResponse.json({ appointment: appt });
  } catch (err) {
    if (err instanceof AppointmentConflictError) return NextResponse.json({ error: "horário indisponível" }, { status: 409 });
    // Antes desta OT, uma falha aqui virava um 500 genérico do Next.js sem
    // nenhum log nosso — agora fica visível e com contexto mínimo.
    logError({ category: "agenda", operation: "create_appointment", establishmentId: id, error: err });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
