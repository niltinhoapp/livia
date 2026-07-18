// GET /api/availability?date=YYYY-MM-DD&duration=30
// Retorna os horários livres do dia, já descontando pausas, antecedência
// mínima e agendamentos existentes.
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import {
  getScheduleConfig,
  listAppointments,
  computeSlots,
  localToEpoch,
} from "@/lib/scheduling";

export async function GET(req: NextRequest) {
  const id = resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const date = req.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "parâmetro date (YYYY-MM-DD) obrigatório" }, { status: 400 });
  }

  const config = await getScheduleConfig(id);
  const duration = Number(req.nextUrl.searchParams.get("duration")) || config.defaultDurationMin;

  // Agendamentos do dia (limites em epoch a partir da meia-noite local).
  const dayStart = localToEpoch(date, 0, config.utcOffsetMinutes);
  const dayEnd = dayStart + 24 * 3600000;
  const existing = await listAppointments(id, dayStart, dayEnd);

  const slots = computeSlots(config, date, duration, existing);
  return NextResponse.json({ date, duration, slots });
}
