export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const toneClass: Record<StatusTone, string> = {
  success: "bg-success-bg text-success-fg",
  warning: "bg-warning-bg text-warning-fg",
  danger: "bg-danger-bg text-danger-fg",
  info: "bg-info-bg text-info-fg",
  neutral: "bg-line/60 text-ink-500",
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-3 py-1 text-xs font-semibold ${toneClass[tone]}`}
    >
      {children}
    </span>
  );
}
