// PATCH /api/appointments/:id
//   { status } -> confirma / cancela / conclui / no_show
//   { startAt, durationMin? } -> remarca (valida novo horário livre)
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import {
  getAppointment,
  listAppointments,
  setStatus,
  updateAppointment,
} from "@/lib/scheduling";
import type { AppointmentStatus } from "@/types";

const VALID: AppointmentStatus[] = ["pending", "confirmed", "cancelled", "completed", "no_show"];

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const estId = await resolveEstablishmentId(req);
  if (!estId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const appt = await getAppointment(estId, params.id);
  if (!appt) return NextResponse.json({ error: "agendamento não encontrado" }, { status: 404 });

  const b = (await req.json().catch(() => ({}))) as {
    status?: AppointmentStatus;
    startAt?: number;
    durationMin?: number;
  };

  // Remarcação
  if (typeof b.startAt === "number") {
    const durationMin = b.durationMin ?? appt.durationMin;
    const existing = await listAppointments(estId, b.startAt - 24 * 3600000, b.startAt + 48 * 3600000);
    const clash = existing.some(
      (a) =>
        a.id !== appt.id &&
        a.status !== "cancelled" &&
        a.status !== "no_show" &&
        b.startAt! < a.startAt + a.durationMin * 60000 &&
        a.startAt < b.startAt! + durationMin * 60000,
    );
    if (clash) return NextResponse.json({ error: "horário indisponível" }, { status: 409 });
    await updateAppointment(estId, appt.id, {
      startAt: b.startAt,
      durationMin,
      status: "pending", // remarcado volta a aguardar confirmação
      confirmedAt: null,
      reminderSentAt: null,
    });
    return NextResponse.json({ ok: true, rescheduled: true });
  }

  // Mudança de status
  if (b.status && VALID.includes(b.status)) {
    await setStatus(estId, appt.id, b.status);
    return NextResponse.json({ ok: true, status: b.status });
  }

  return NextResponse.json({ error: "nada a atualizar" }, { status: 400 });
}
