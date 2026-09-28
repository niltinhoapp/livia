// Busca textual do cardápio (search_menu) — função pura, sem I/O.
//
// A busca antiga era substring exata de "nome descrição" em minúsculas:
// "coca" achava "Coca-Cola", mas "coca cola", "coca lata" e "coca 350ml" não
// achavam nada — o volume vive na VARIAÇÃO ("Lata 350ml") e o hífen do nome
// não casava com espaço. A regra nova é genérica (nenhum termo fixo, nenhum
// alias de produto): normaliza acento, caixa, pontuação e número colado em
// unidade, e exige que TODAS as palavras da busca apareçam em nome, descrição
// ou variações ativas. A substring antiga continua valendo, então nada que
// era encontrado deixa de ser.

// Palavras de ligação que não identificam produto.
const STOPWORDS = new Set(["de", "da", "do", "das", "dos", "o", "a", "os", "as", "um", "uma", "e", "com"]);

export function normalizeMenuText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryTokens(query: string): string[] {
  return normalizeMenuText(query).split(" ").filter((token) => token && !STOPWORDS.has(token));
}

function tokenMatches(token: string, haystack: string[]): boolean {
  if (haystack.some((word) => word.startsWith(token))) return true;
  // Plural simples ("cocas", "latas") casa com o singular cadastrado.
  return token.length > 3 && token.endsWith("s") && haystack.some((word) => word === token.slice(0, -1));
}

export interface SearchableMenuProduct {
  name: string;
  description?: string | null;
  variants?: { name: string; active: boolean }[];
}

export function menuProductMatches(product: SearchableMenuProduct, rawQuery: string): boolean {
  const legacyQuery = rawQuery.trim().toLocaleLowerCase("pt-BR");
  if (!legacyQuery) return false;
  if (`${product.name} ${product.description ?? ""}`.toLocaleLowerCase("pt-BR").includes(legacyQuery)) return true;
  const tokens = queryTokens(rawQuery);
  if (!tokens.length) return false;
  const activeVariants = (product.variants ?? []).filter((variant) => variant.active).map((variant) => variant.name);
  const haystack = normalizeMenuText([product.name, product.description ?? "", ...activeVariants].join(" ")).split(" ");
  return tokens.every((token) => tokenMatches(token, haystack));
}
