// Skeletons para substituir spinners onde o layout é previsível (listas de
// conversas/clientes/agenda, cards do overview). Aditivo — as páginas passam
// a usar nas fases seguintes; o LoadingState (spinner) continua existindo.

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-ink-100 ${className}`} aria-hidden />;
}

// Linha de lista genérica (avatar + duas linhas de texto).
export function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-3">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    </div>
  );
}

export function SkeletonList({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Carregando…">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} />
      ))}
    </div>
  );
}

// Cartão de métrica/estatística (para o overview).
export function SkeletonCard() {
  return (
    <div className="rounded-card border border-line bg-white p-5 shadow-card sm:p-6">
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-6 w-16" />
        </div>
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>
      <Skeleton className="mt-4 h-3 w-28" />
    </div>
  );
}
