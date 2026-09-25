import { sub } from "@/lib/firebase/admin";

export interface DemoSafetyConfig { legacyAliases?: string[]; }

const normalized = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");

/** Configurável por tenant em establishments/{id}/meta/demoSafety. */
export async function isLegacyBusinessInquiry(establishmentId: string, text: string): Promise<boolean> {
  const snap = await sub(establishmentId, "meta").doc("demoSafety").get();
  const aliases = snap.exists ? (snap.data() as DemoSafetyConfig).legacyAliases : [];
  if (!Array.isArray(aliases) || !aliases.length) return false;
  const message = normalized(text);
  return aliases.some((alias) => typeof alias === "string" && alias.trim().length >= 3 && message.includes(normalized(alias.trim())));
}

export const LEGACY_DEMO_CHANNEL_REPLY =
  "Este número atualmente é um canal de demonstração da Lívia, da ConectWeb, e não pertence ao estabelecimento que você procura.";
