"use server";

import { cookies } from "next/headers";
import { resolveAdminAccess } from "@/lib/auth/adminSession";
import { SESSION_COOKIE_NAME } from "@/lib/auth/session";
import { extendAdminEstablishmentTrial } from "@/lib/repo.admin";
import { disconnectWhatsapp } from "@/lib/repo";
import { revalidatePath } from "next/cache";

/**
 * Valida o acesso administrativo no contexto de uma Server Action.
 */
async function requireAdmin() {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  const resolution = await resolveAdminAccess(cookie);
  if (resolution.status !== "allowed") {
    throw new Error("Não autorizado");
  }
  return resolution.uid;
}

/**
 * Adiciona dias ao período de trial e reativa a conta.
 */
export async function actionExtendTrial(establishmentId: string, additionalDays: number) {
  await requireAdmin();
  await extendAdminEstablishmentTrial(establishmentId, additionalDays);
  
  revalidatePath(`/admin/establishments/${establishmentId}`);
  return { success: true };
}

/**
 * Desconecta forçadamente a integração do WhatsApp via Meta Cloud API.
 */
export async function actionDisconnectWhatsapp(establishmentId: string) {
  await requireAdmin();
  const result = await disconnectWhatsapp(establishmentId);
  
  revalidatePath(`/admin/establishments/${establishmentId}`);
  return { success: true, outcome: result.outcome };
}
