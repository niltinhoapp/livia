import { forwardRef } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

const controlClass =
  "w-full rounded-control border border-line px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:bg-line/20 disabled:text-ink-400";

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <label className="mb-1.5 block text-sm font-semibold text-ink-700">
      {children}
      {hint && <span className="ml-1.5 font-normal text-ink-400">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input ref={ref} className={`${controlClass} ${className}`} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className = "", ...props }, ref) => (
    <textarea ref={ref} className={`${controlClass} min-h-[80px] resize-y ${className}`} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className = "", children, ...props }, ref) => (
    <select ref={ref} className={`${controlClass} bg-white ${className}`} {...props}>
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function FieldHelp({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs text-ink-400">{children}</p>;
}
