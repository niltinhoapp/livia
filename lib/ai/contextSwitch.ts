// Detecta uma mudança explícita de assunto que não pode herdar uma tarefa
// operacional antiga (ex.: agenda). Mantemos esta decisão determinística para
// impedir que números do novo assunto sejam interpretados como data/horário.
export function startsAuditContext(text: string): boolean {
  const normalized = text
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;

  const mentionsAudit =
    /\b(auditoria(?: de atendimento)?|calculadora(?: de atendimento)?|diagnostico(?: de atendimento)?)\b/.test(normalized);
  const mentionsCalculatedLoss =
    /\b(calcul(?:o|ou|ado|ada)|estimativa|indicou)\b/.test(normalized) &&
    /\b(perd(?:o|a|endo|er|ido|ida)|perda|desperdic(?:o|ando|ar))\b/.test(normalized);

  return mentionsAudit || mentionsCalculatedLoss;
}

export function taskAfterExplicitContextSwitch<T>(text: string, task: T | null): T | null {
  return startsAuditContext(text) ? null : task;
}
