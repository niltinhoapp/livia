// GET /api/schedule  -> configuração da agenda (ou o padrão)
// PUT /api/schedule  -> salva a configuração da agenda
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getScheduleConfig, saveScheduleConfig, defaultScheduleConfig } from "@/lib/scheduling";
import type { ScheduleConfig } from "@/types";

export async function GET(req: NextRequest) {
  const id = resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });
  return NextResponse.json({ schedule: await getScheduleConfig(id) });
}

export async function PUT(req: NextRequest) {
  const id = resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as Partial<ScheduleConfig> | null;
  if (!raw) return NextResponse.json({ error: "payload inválido" }, { status: 400 });

  const base = defaultScheduleConfig(id);
  const cfg = await saveScheduleConfig(id, {
    timezone: raw.timezone ?? base.timezone,
    utcOffsetMinutes: typeof raw.utcOffsetMinutes === "number" ? raw.utcOffsetMinutes : base.utcOffsetMinutes,
    slotMinutes: typeof raw.slotMinutes === "number" ? raw.slotMinutes : base.slotMinutes,
    defaultDurationMin: typeof raw.defaultDurationMin === "number" ? raw.defaultDurationMin : base.defaultDurationMin,
    leadHours: typeof raw.leadHours === "number" ? raw.leadHours : base.leadHours,
    days: raw.days ?? base.days,
    reminderTemplateName: raw.reminderTemplateName ?? null,
    reminderTemplateLang: raw.reminderTemplateLang ?? base.reminderTemplateLang,
  });
  return NextResponse.json({ schedule: cfg });
}
