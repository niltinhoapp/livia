// Pedido explícito, por texto, de resposta em áudio. A própria Lívia oferece
// "posso te responder por áudio" (revelação da prospecção), então as respostas
// naturais a essa oferta precisam ser reconhecidas — não só "manda um áudio".
// Negação ("não precisa de áudio", "prefiro texto") nunca vira áudio.
export function textRequestsVoice(text: string): boolean {
  const value = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pt-BR");
  if (/\b(?:nao|sem)\s+(?:\w+\s+){0,2}audio\b|\bprefiro\s+(?:por\s+|em\s+)?(?:texto|escrito|mensagem)\b/.test(value)) return false;
  return /\b(manda(\s+um)? audio|me responde (em )?audio|quero ouvir|pode explicar por audio)\b/.test(value)
    || /\b(?:(?:mand|envi|respond|fal|grav)(?:a|e|ar|er)|expli(?:ca|que|car))\b(?:\s+\w+){0,2}\s+(?:em|por|num|no)\s+audio\b/.test(value)
    || /\b(?:prefiro|pode\s+ser|quero|melhor)\s+(?:por\s+|em\s+|um\s+|o\s+)?audio\b/.test(value);
}
