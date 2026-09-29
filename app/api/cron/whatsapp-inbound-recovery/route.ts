import { NextRequest, NextResponse } from "next/server";
import { drainConversationInbox } from "@/app/api/webhooks/whatsapp/route";
import { deleteExpiredWhatsAppProcessedMarkers, listRecoverableWhatsAppInboundJobs } from "@/lib/repo";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "não autorizado" }, { status: 401 });
  }
  // Uma conversa com muitos jobs não pode consumir sozinha toda a janela.
  // Lê uma faixa maior e limita por conversa, preservando justiça global.
  const jobs = await listRecoverableWhatsAppInboundJobs(100);
  const conversations = new Map<string, (typeof jobs)[number]>();
  for (const job of jobs) {
    if (!conversations.has(job.conversationKey)) conversations.set(job.conversationKey, job);
    if (conversations.size === 10) break;
  }
  const results = await Promise.allSettled([...conversations.values()].map((job) =>
    drainConversationInbox(job.establishmentId, job.conversationId)));
  const expiredMarkersDeleted = await deleteExpiredWhatsAppProcessedMarkers();
  // Avisos de atendimento humano interrompidos (queda entre gravar o handoff
  // e enviar o aviso). Efeito colateral: nunca muda posse da conversa.
  let handoffNotifications: { establishments: number; episodes: number } | { error: string };
  try {
    const { recoverHandoffNotifications } = await import("@/lib/humanHandoff/notifications");
    handoffNotifications = await recoverHandoffNotifications();
  } catch (error) {
    handoffNotifications = { error: error instanceof Error ? error.name : "unknown" };
  }
  return NextResponse.json({
    conversations: conversations.size,
    succeeded: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    expiredMarkersDeleted,
    handoffNotifications,
  });
}
