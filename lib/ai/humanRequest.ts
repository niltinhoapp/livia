// Leitura determinística de "o cliente quer (ou não quer) falar com um
// humano".
//
// Existe por causa do pior sintoma observado em Production (06/09/2026): a
// Livia ofereceu atendente, o cliente respondeu "n", e a conversa ficou
// MUDA. O handoff era gravado no mesmo turno da oferta e não havia caminho
// de volta pelo WhatsApp — só o botão "Devolver para Livia" no painel, que o
// cliente obviamente não tem.
//
// A decisão de calar a Livia é a mais cara do sistema. Ela não pode depender
// de o modelo interpretar bem um "não" — nem, no sentido contrário, de o
// cliente usar as palavras exatas para ser atendido por uma pessoa.
//
// Regra de projeto (igual a lib/ai/confirmation.ts): a NEGAÇÃO vence. Diante
// de dúvida entre "quer humano" e "não quer", o resultado é "none" e nada
// muda — nunca calamos nem retomamos a conversa por um palpite.

export type HumanIntent = "asks" | "declines" | "none";

function normalizar(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[.!,;?]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Quem é "o humano": atendente, pessoa, alguém da equipe. Usado dos dois
// lados (pedido e recusa) para não duplicar a lista.
const HUMANO = "(atendente|humano|pessoa|alguem|ninguem|funcionari[oa]|recep[cç]ao|secretari[oa]|gerente|respons[aá]vel)";

// Recusas. Cobrem tanto "não quero atendente" quanto o inverso positivo
// ("pode continuar você"), que é uma recusa disfarçada de elogio.
const RECUSA = new RegExp(
  [
    `\\bnao\\s+(quero|preciso|precisa|precisamos|quer)\\b.*\\b${HUMANO}\\b`,
    `\\bnao\\s+(precisa|quero)\\s+(chamar|transferir|falar)\\b`,
    `\\bnao\\s+(chama|chame|transfere|transfira)\\b`,
    `\\b(pode|podes)\\s+continuar\\s+(voce|vc|tu)\\b`,
    `\\b(continua|continue|segue|siga)\\s+(voce|vc|tu)\\b`,
    `\\bdeixa\\s+(voce|vc|tu|contigo)\\b`,
    `\\b(prefiro|quero)\\s+(falar\\s+)?(com\\s+)?(voce|vc|tu)\\b`,
    `\\bnao\\s+precisa\\b`,
    `\\bresolve\\s+(voce|vc|tu)\\b`,
  ].join("|"),
);

// Pedidos explícitos de humano.
const PEDIDO = new RegExp(
  [
    `\\b(quero|queria|prefiro|preciso|pode|poderia|consegue)\\b.*\\bfalar\\b.*\\b${HUMANO}\\b`,
    `\\bfalar\\s+com\\s+(um[a]?\\s+)?${HUMANO}\\b`,
    `\\b(chama|chame|chamar|passa|passe|transfere|transfira|transferir)\\b.*\\b${HUMANO}\\b`,
    `\\bme\\s+(transfere|transfira|passa|passe)\\b`,
    `\\bquero\\s+(um[a]?\\s+)?${HUMANO}\\b`,
    `\\batendimento\\s+humano\\b`,
    `\\bpessoa\\s+de\\s+verdade\\b`,
  ].join("|"),
);

export function readHumanIntent(text: string): HumanIntent {
  const t = normalizar(text);
  if (!t) return "none";

  // Negação primeiro, sempre: "não quero falar com atendente" contém o
  // pedido inteiro dentro dela.
  if (RECUSA.test(t)) return "declines";
  if (PEDIDO.test(t)) return "asks";
  return "none";
}

// A Livia ofereceu chamar alguém nesta mensagem? Serve para dar sentido a um
// "não" seco: sozinho ele não diz nada, mas logo depois de uma oferta de
// atendente é uma recusa clara. Mesmo padrão já usado para ler o horário
// proposto (extractSingleTime em lib/ai/timeSelection.ts).
const OFERTA_DE_HUMANO = new RegExp(
  [
    `\\b(chamar|chamo|chame|chama|transferir|transfiro|transferi|passar)\\b.*\\b${HUMANO}\\b`,
    `\\b${HUMANO}\\b.*\\b(pode|poderia)\\s+(te\\s+)?ajudar\\b`,
    `\\batendimento\\s+humano\\b`,
  ].join("|"),
);

export function offeredHuman(botText: string): boolean {
  return OFERTA_DE_HUMANO.test(normalizar(botText));
}

// A resposta ANUNCIA uma transferência ("vou transferir você", "será
// transferido")? Diferente de OFERTA_DE_HUMANO de propósito: "posso
// transferir?" pergunta, "vou transferir" afirma.
//
// Serve para o mesmo princípio já aplicado à reserva — a resposta tem que
// refletir o estado real. Em Production (06/09/2026) o cliente escreveu "nao
// precisa chamar ninguem", o sistema corretamente NÃO transferiu (ela
// continuou respondendo depois), e mesmo assim o texto dizia "Vou transferir
// você para um atendente agora". A trava impedia a mudança de estado, não a
// frase.
const ANUNCIA_TRANSFERENCIA = new RegExp(
  [
    `\\b(vou|irei|estou|vamos)\\s+(transferir|transferindo|chamar|chamando|passar|passando)\\b(?!.*\\?)`,
    `\\bser[aá]\\s+transferid[oa]\\b`,
    `\\b(transferindo|encaminhando)\\s+(voce|vc|seu atendimento)\\b`,
  ].join("|"),
);

export function announcesTransfer(reply: string): boolean {
  return ANUNCIA_TRANSFERENCIA.test(normalizar(reply));
}
