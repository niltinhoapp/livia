import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`rounded-card border border-line bg-white p-5 shadow-card sm:p-6 ${className}`}
      {...props}
    />
  );
}

export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h2 className={`mb-4 text-lg font-semibold text-ink-900 ${className}`}>{children}</h2>;
}
