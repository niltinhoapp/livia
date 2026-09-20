import type { HTMLAttributes, ReactNode } from "react";
export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`rounded-card border border-line bg-white p-4 shadow-e1 sm:p-6 transition-shadow duration-150 hover:shadow-e2 ${className}`} {...props} />;
}
export function CardTitle({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <h2 className={`mb-4 text-base font-semibold tracking-tight text-ink-900 ${className}`}>{children}</h2>;
}
