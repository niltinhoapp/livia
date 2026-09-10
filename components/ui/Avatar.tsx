import type { ReactNode } from "react";

// Avatar por iniciais, com cor de fundo determinística a partir do
// nome/telefone — para dar identidade visual consistente às listas de
// conversas e clientes sem depender de imagem. Puramente apresentacional.
const PALETTE = [
  "bg-primary-light text-primary",
  "bg-info-bg text-info-fg",
  "bg-success-bg text-success-fg",
  "bg-warning-bg text-warning-fg",
  "bg-ink-100 text-ink-600",
];

const SIZES = {
  sm: "h-8 w-8 text-xs",
  md: "h-9 w-9 text-sm",
  lg: "h-12 w-12 text-base",
} as const;

function initials(label: string): string {
  const clean = label.trim();
  if (!clean) return "?";
  // Se for só dígitos (telefone), usa os 2 últimos.
  if (/^[\d\s()+-]+$/.test(clean)) {
    const digits = clean.replace(/\D/g, "");
    return digits.slice(-2) || "?";
  }
  const parts = clean.split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]![0] : "";
  return (first + last).toUpperCase() || "?";
}

function colorFor(label: string): string {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

export function Avatar({
  name,
  phone,
  size = "md",
  className = "",
  icon,
}: {
  name?: string | null;
  phone?: string | null;
  size?: keyof typeof SIZES;
  className?: string;
  icon?: ReactNode;
}) {
  const label = name || phone || "?";
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${SIZES[size]} ${colorFor(label)} ${className}`}
      aria-hidden
    >
      {icon ?? initials(label)}
    </span>
  );
}
