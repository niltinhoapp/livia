import { FieldValue } from "firebase-admin/firestore";
import { establishmentRef } from "@/lib/firebase/admin";
import { normalizeConnectionMode, type WhatsappConnectionMode } from "@/lib/whatsapp/coexistence";

/**
 * Persiste o modo do canal sem alterar o restante do documento de WhatsApp.
 * O campo é opcional por compatibilidade: documentos antigos sem o campo
 * continuam sendo tratados como Cloud API.
 */
export async function persistWhatsappConnectionMode(
  establishmentId: string,
  mode: WhatsappConnectionMode,
): Promise<void> {
  await establishmentRef(establishmentId).update({
    "whatsapp.connectionMode": mode,
  });
}

/**
 * Leitura conservadora do modo persistido. Ausência/valor inválido = Cloud API.
 */
export function readWhatsappConnectionMode(value: unknown): WhatsappConnectionMode {
  return normalizeConnectionMode(value);
}

/**
 * Remove o modo somente quando o documento já não tem uma conexão WhatsApp.
 * Mantido separado para não interferir no disconnect existente enquanto o
 * Coexistence ainda está sendo implantado.
 */
export async function clearWhatsappConnectionMode(establishmentId: string): Promise<void> {
  await establishmentRef(establishmentId).update({
    "whatsapp.connectionMode": FieldValue.delete(),
  });
}
