import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-card border border-primary-200/80 bg-white p-5 shadow-e2 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-e3 sm:p-6 ${className}`} {...props} />;
}
export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h2 className={`mb-4 border-l-4 border-primary pl-3 text-lg font-semibold text-ink-900 ${className}`}>{children}</h2>;
}
