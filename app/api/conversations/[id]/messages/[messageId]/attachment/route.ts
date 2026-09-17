import { NextRequest, NextResponse } from "next/server";
import { resolveEstablishmentId } from "@/lib/auth/session";
import { getMessage } from "@/lib/repo";
import { readConversationAttachment } from "@/lib/attachments/storage";

export const dynamic = "force-dynamic";

function contentDisposition(filename: string, inline: boolean): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "anexo";
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function isSafeDocumentId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,160}$/.test(value);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const establishmentId = await resolveEstablishmentId(req);
  if (!establishmentId) return NextResponse.json({ error: "estabelecimento não identificado" }, { status: 401 });

  const { id: conversationId, messageId } = await params;
  if (!isSafeDocumentId(conversationId) || !isSafeDocumentId(messageId)) {
    return NextResponse.json({ error: "anexo não encontrado" }, { status: 404 });
  }
  const message = await getMessage(establishmentId, conversationId, messageId);
  const attachment = message?.attachment;
  if (!attachment) return NextResponse.json({ error: "anexo não encontrado" }, { status: 404 });

  try {
    const bytes = await readConversationAttachment(establishmentId, conversationId, attachment.storageRef);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const inline = attachment.type === "image" || attachment.mimeType === "application/pdf";
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": contentDisposition(attachment.filename, inline),
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
      },
    });
  } catch {
    return NextResponse.json({ error: "anexo indisponível" }, { status: 503 });
  }
}
