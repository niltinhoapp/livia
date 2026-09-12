import type { ReactNode } from "react";
import { Card } from "./Card";

// Cartão de estatística/estado — consolida os vários cartões "label + valor +
// ícone + link" que hoje são repetidos à mão (visão geral, painel diário).
// Puramente apresentacional.
type StatTone = "primary" | "success" | "warning" | "danger" | "info" | "neutral";

const toneClass: Record<StatTone, string> = {
  primary: "bg-primary-light text-primary",
  success: "bg-success-bg text-success-fg",
  warning: "bg-warning-bg text-warning-fg",
  danger: "bg-danger-bg text-danger-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-ink-100 text-ink-500",
};

export function StatCard({
  label,
  value,
  icon,
  tone = "neutral",
  footer,
  className = "",
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-500">{label}</p>
          <p className="mt-1 text-2xl font-bold text-ink-900">{value}</p>
        </div>
        {icon && (
          <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${toneClass[tone]}`}>
            {icon}
          </div>
        )}
      </div>
      {footer && <div className="mt-4">{footer}</div>}
    </Card>
  );
}
