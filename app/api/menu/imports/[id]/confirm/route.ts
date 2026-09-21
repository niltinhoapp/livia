import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { MenuImportError, confirmMenuImport } from "@/lib/menuImport";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { return NextResponse.json({ item: await confirmMenuImport(est, id) }); } catch (error) { const code = error instanceof MenuImportError ? error.code : "confirmation_failed"; return NextResponse.json({ error: code }, { status: code === "not_found" ? 404 : 409 }); } }
