// Rótulos de exibição — só para o frontend. O valor real (EstablishmentType)
// continua definido em types/index.ts; este mapa nunca deve virar fonte de
// verdade de dado, só de texto.
import type { EstablishmentType } from "@/types";

export const ESTABLISHMENT_TYPE_LABELS: Record<EstablishmentType, string> = {
  clinica: "Clínica",
  pet: "Pet",
  salao: "Salão",
  estetica: "Estética",
  odonto: "Odonto",
  outro: "Outro",
};

export const WEEKDAY_LABELS: { key: string; label: string; short: string }[] = [
  { key: "1", label: "Segunda", short: "Seg" },
  { key: "2", label: "Terça", short: "Ter" },
  { key: "3", label: "Quarta", short: "Qua" },
  { key: "4", label: "Quinta", short: "Qui" },
  { key: "5", label: "Sexta", short: "Sex" },
  { key: "6", label: "Sábado", short: "Sáb" },
  { key: "0", label: "Domingo", short: "Dom" },
];
