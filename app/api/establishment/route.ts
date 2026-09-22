// GET /api/establishment  -> dados + config do bot (ou um padrão se ainda não existe)
// PUT /api/establishment  -> salva nome, tipo e config do bot
import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getEstablishment, upsertEstablishmentConfig, defaultBotConfig } from "@/lib/repo";
import type { BotConfig, Establishment, EstablishmentType, DailyOwnerSummaryConfig } from "@/types";

const TYPES: EstablishmentType[] = [
  "clinica",
  "pet",
  "salao",
  "estetica",
  "odonto",
  "oficina",
  "academia",
  "imobiliaria",
  "restaurante", "lanchonete", "pizzaria", "hamburgueria",
  "outro",
];

type ClientEstablishment = Omit<Establishment, "whatsapp"> & {
  whatsapp?: Omit<NonNullable<Establishment["whatsapp"]>, "accessToken" | "pin" | "pinsByPhoneNumberId">;
};

function sanitizeEstablishmentForClient(establishment: Establishment): ClientEstablishment {
  const { whatsapp, ...publicEstablishment } = establishment;
  if (!whatsapp) return publicEstablishment;

  const { accessToken: _accessToken, pin: _pin, pinsByPhoneNumberId: _pinsByPhoneNumberId, ...publicWhatsapp } = whatsapp;
  return { ...publicEstablishment, whatsapp: publicWhatsapp };
}

export async function GET(req: NextRequest) {
  const id = await resolveEstablishmentId(req);
  if (!id) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const est = await getEstablishment(id);
  if (est) return NextResponse.json({ establishment: sanitizeEstablishmentForClient(est), exists: true });
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
    dailyOwnerSummary?: Partial<DailyOwnerSummaryConfig>;
  } | null;
  if (!raw) return NextResponse.json({ error: "payload inválido" }, { status: 400 });

  const base = defaultBotConfig();
  const bot: BotConfig | undefined = raw.bot
    ? {
        personaName: String(raw.bot.personaName ?? base.personaName).trim() || base.personaName,
        tone: String(raw.bot.tone ?? base.tone).trim() || base.tone,
        bookingEnabled: Boolean(raw.bot.bookingEnabled),
        ordersEnabled: Boolean(raw.bot.ordersEnabled),
        voiceRepliesEnabled: Boolean(raw.bot.voiceRepliesEnabled),
        medicalGuardrail: Boolean(raw.bot.medicalGuardrail),
        handoffKeywords: Array.isArray(raw.bot.handoffKeywords)
          ? raw.bot.handoffKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean)
          : base.handoffKeywords,
      }
    : undefined;

  const dailyOwnerSummary: DailyOwnerSummaryConfig | undefined = raw.dailyOwnerSummary
    ? {
        enabled: Boolean(raw.dailyOwnerSummary.enabled),
        ownerPhone: String(raw.dailyOwnerSummary.ownerPhone ?? "").replace(/\D/g, "").slice(0, 15),
        templateName: String(raw.dailyOwnerSummary.templateName ?? "").trim().slice(0, 128),
        templateLang: String(raw.dailyOwnerSummary.templateLang ?? "pt_BR").trim() || "pt_BR",
      }
    : undefined;

  const est = await upsertEstablishmentConfig(id, {
    name: raw.name !== undefined ? String(raw.name).trim() : undefined,
    type: raw.type && TYPES.includes(raw.type) ? raw.type : undefined,
    bot,
    dailyOwnerSummary,
  });
  return NextResponse.json({ establishment: sanitizeEstablishmentForClient(est) });
}
