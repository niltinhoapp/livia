// GET /api/establishment  -> dados + config do bot (ou um padrão se ainda não existe)
// PUT /api/establishment  -> salva nome, tipo e config do bot
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment, upsertEstablishmentConfig, defaultBotConfig } from "@/lib/repo";
import type { BotConfig, EstablishmentType } from "@/types";

const TYPES: EstablishmentType[] = [
  "clinica",
  "pet",
  "salao",
  "estetica",
  "odonto",
  "oficina",
  "academia",
  "imobiliaria",
  "outro",
];

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const est = await getEstablishment(id);
  if (est) return NextResponse.json({ establishment: est, exists: true });
  // Ainda não cadastrado: devolve um esqueleto com padrões pro painel editar.
  return NextResponse.json({
    establishment: { id, name: "", type: "outro", status: "active", bot: defaultBotConfig() },
    exists: false,
  });
}

export async function PUT(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const raw = (await req.json().catch(() => null)) as {
    name?: string;
    type?: EstablishmentType;
    bot?: Partial<BotConfig>;
  } | null;
  if (!raw) return NextResponse.json({ error: "payload inválido" }, { status: 400 });

  const base = defaultBotConfig();
  const bot: BotConfig | undefined = raw.bot
    ? {
        personaName: String(raw.bot.personaName ?? base.personaName).trim() || base.personaName,
        tone: String(raw.bot.tone ?? base.tone).trim() || base.tone,
        bookingEnabled: Boolean(raw.bot.bookingEnabled),
        medicalGuardrail: Boolean(raw.bot.medicalGuardrail),
        handoffKeywords: Array.isArray(raw.bot.handoffKeywords)
          ? raw.bot.handoffKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
          : base.handoffKeywords,
      }
    : undefined;

  const est = await upsertEstablishmentConfig(id, {
    name: raw.name !== undefined ? String(raw.name).trim() : undefined,
    type: raw.type && TYPES.includes(raw.type) ? raw.type : undefined,
    bot,
  });
  return NextResponse.json({ establishment: est });
}
