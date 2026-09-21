import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { MenuImportError, updateMenuImportPreview } from "@/lib/menuImport";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) { const est = await resolveEstablishmentId(req); const { id } = await params; if (!est) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 }); try { return NextResponse.json({ item: await updateMenuImportPreview(est, id, (await req.json()).preview) }); } catch (error) { return NextResponse.json({ error: error instanceof MenuImportError ? error.code : "preview_invalid" }, { status: 400 }); } }
