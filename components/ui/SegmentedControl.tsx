"use client";
import type { ReactNode } from "react";

// Padroniza os múltiplos "seletores de pílula" que hoje existem em variações
// diferentes: abas de /configuracoes (segmented) e chips de filtro em
// /conversas e /conhecimento (chips). Aditivo — adoção incremental por página.

interface SegItem<T extends string> {
  id: T;
  label: ReactNode;
}

// Segmented control (fundo cinza, aba ativa em branco elevada) — mesmo visual
// das abas atuais de Configurações, agora reutilizável.
export function SegmentedControl<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: SegItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div role="tablist" className={`flex gap-1 rounded-control bg-ink-100 p-1 ${className}`}>
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(it.id)}
            className={`flex-1 rounded-sm px-3 py-2 text-sm font-semibold transition-colors duration-150 ${
              active ? "bg-white text-ink-900 shadow-e1" : "text-ink-500 hover:text-ink-700"
            }`}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

// Chip de filtro (formato pílula) — usado em listas com filtros rápidos.
export function Chip({
  active = false,
  onClick,
  className = "",
  children,
}: {
  active?: boolean;
  onClick?: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors duration-150 ${
        active
          ? "border-primary bg-primary text-white"
          : "border-line text-ink-500 hover:bg-ink-50 hover:text-ink-700"
      } ${className}`}
    >
      {children}
    </button>
  );
}
