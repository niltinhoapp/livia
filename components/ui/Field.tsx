import { forwardRef } from "react";
import type { InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes, ReactNode } from "react";

const controlBase =
  "w-full rounded-control border px-3 py-2.5 text-sm text-ink-900 placeholder:text-ink-400 transition-colors duration-150 focus:outline-none disabled:bg-line/20 disabled:text-ink-400";
const controlValid = "border-line focus:border-primary focus:ring-2 focus:ring-primary/20";
const controlInvalid = "border-danger focus:border-danger focus:ring-2 focus:ring-danger/20";

// Novo (opcional, aditivo): marca visual de erro. Quem não passar `invalid`
// não muda em nada. `invalid` é retirado dos props espalhados no DOM.
type InvalidProp = { invalid?: boolean };

export function Label({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <label className="mb-1.5 block text-sm font-semibold text-ink-700">
      {children}
      {hint && <span className="ml-1.5 font-normal text-ink-400">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & InvalidProp>(
  ({ className = "", invalid = false, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`${controlBase} ${invalid ? controlInvalid : controlValid} ${className}`}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & InvalidProp>(
  ({ className = "", invalid = false, ...props }, ref) => (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`${controlBase} ${invalid ? controlInvalid : controlValid} min-h-[80px] resize-y ${className}`}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement> & InvalidProp>(
  ({ className = "", invalid = false, children, ...props }, ref) => (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={`${controlBase} ${invalid ? controlInvalid : controlValid} bg-white ${className}`}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function FieldHelp({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs text-ink-400">{children}</p>;
}

export function FieldError({ children }: { children: ReactNode }) {
  return <p className="mt-1.5 text-xs font-medium text-danger-fg">{children}</p>;
}

// Wrapper opcional que agrupa label + controle + hint/erro de forma
// consistente. Aditivo: as páginas atuais que compõem Label+Input à mão
// continuam funcionando sem mudança.
export function Field({
  label,
  hint,
  help,
  error,
  children,
}: {
  label?: ReactNode;
  hint?: string;
  help?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      {label && <Label hint={hint}>{label}</Label>}
      {children}
      {error ? <FieldError>{error}</FieldError> : help ? <FieldHelp>{help}</FieldHelp> : null}
    </div>
  );
}
