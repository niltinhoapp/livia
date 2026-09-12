import type { ReactNode } from "react";

// Badge genérico para as "pílulas" ad-hoc espalhadas pelo app (intenções,
// contadores, rótulos "recomendado", etc.). Diferente de StatusBadge, que é
// específico de status de conversa/agendamento — este é o rótulo neutro
// reutilizável. Aditivo: nenhuma página é obrigada a adotá-lo.
export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "danger" | "info";

const toneClass: Record<BadgeTone, string> = {
  neutral: "bg-ink-100 text-ink-600",
  primary: "bg-primary-light text-primary",
  success: "bg-success-bg text-success-fg",
  warning: "bg-warning-bg text-warning-fg",
  danger: "bg-danger-bg text-danger-fg",
  info: "bg-info-bg text-info-fg",
};

export function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneClass[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
