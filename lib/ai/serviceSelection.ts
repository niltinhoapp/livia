// Serviço citado pelo cliente na mensagem atual — resolvido por código,
// contra a lista de serviços cadastrados. Espelha lib/ai/dateSelection.ts:
// é determinístico e conservador (nunca adivinha), e serve para que o serviço
// mais recente e explícito do cliente vença um `serviceName` que ficou preso
// na tarefa de um fluxo anterior (ver collectFromTools em lib/ai/taskState.ts
// e resolveTimeSelection em lib/ai/brain.ts — mesmo papel do statedDate).
//
// O caso real (OT-02G): a conversa carregava serviceName="Tratamento de Canal"
// de um fluxo anterior; o cliente pediu "avaliação"; sem capturar isso, uma
// seleção de horário criava um Canal em vez da Avaliação.
import type { KnowledgeService } from "@/types";

function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// O nome do serviço aparece no texto como uma unidade lexical inteira?
// Fronteira de palavra sobre o texto JÁ normalizado (minúsculo, sem acento):
// o nome não pode estar colado a outra letra/dígito antes ou depois. Assim
// "Ana" não casa dentro de "banana", "Corte" não casa em "recorte" e "Gel"
// não casa em "gelado" — mas o nome completo, cercado por espaço/pontuação/
// início/fim, casa normalmente. Nomes com várias palavras ("Tratamento de
// Canal") são tratados como a mesma unidade.
function mentionsService(normalizedText: string, normalizedName: string): boolean {
  if (!normalizedName) return false;
  const re = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalizedName)}(?:[^a-z0-9]|$)`);
  return re.test(normalizedText);
}

// Devolve o NOME CANÔNICO (como cadastrado na base) do único serviço citado
// no texto, ou null. Conservador de propósito:
//   - o nome COMPLETO do serviço precisa aparecer como unidade lexical
//     (fronteira de palavra) — nunca como pedaço de outra palavra;
//   - se mais de um serviço distinto casar, devolve null (não escolhe);
//   - quando um nome é substring de outro (ex.: "Avaliação" e "Avaliação de
//     Canal") e ambos aparecem, isso conta como ambíguo -> null.
// Falso negativo é seguro (o fluxo segue como antes); um falso positivo
// poderia trocar o serviço indevidamente, então o critério é estrito.
export function parseServiceSelection(
  text: string,
  services: KnowledgeService[] | undefined,
): string | null {
  if (!services?.length) return null;
  const t = normalize(text);
  if (!t) return null;

  const hits = services
    .map((s) => s.name)
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .filter((name) => mentionsService(t, normalize(name)));

  // Nomes canônicos distintos citados (case/acento-insensível).
  const distinct = [...new Set(hits.map((name) => normalize(name)))];
  if (distinct.length !== 1) return null;

  // Devolve o nome exatamente como está cadastrado.
  return hits.find((name) => normalize(name) === distinct[0]) ?? null;
}
