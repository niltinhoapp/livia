import type { ReactNode } from "react";
import { Loader2, Inbox, AlertTriangle } from "lucide-react";
import { Button } from "./Button";

export function LoadingState({ label = "Carregando…" }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-ink-400">
      <Loader2 className="h-6 w-6 animate-spin" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-line/50 text-ink-400">
        {icon ?? <Inbox className="h-5 w-5" />}
      </div>
      <p className="text-sm font-semibold text-ink-700">{title}</p>
      {description && <p className="max-w-sm text-sm text-ink-500">{description}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Não foi possível carregar",
  description = "Tente novamente em instantes.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-danger/30 bg-danger-bg/40 px-6 py-14 text-center">
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white text-danger">
        <AlertTriangle className="h-5 w-5" />
      </div>
      <p className="text-sm font-semibold text-ink-900">{title}</p>
      <p className="max-w-sm text-sm text-ink-500">{description}</p>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
    </div>
  );
}
