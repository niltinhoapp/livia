"use client";

import { forwardRef } from "react";
import type { InputHTMLAttributes } from "react";
import { Search, X } from "lucide-react";

interface SearchInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  onClear?: () => void;
}

export const SearchInput = forwardRef<HTMLInputElement, SearchInputProps>(
  ({ value, onChange, onClear, placeholder = "Buscar…", className = "", ...props }, ref) => {
    const hasValue = Boolean(value && String(value).length > 0);

    return (
      <div className={`relative flex items-center ${className}`}>
        <Search className="pointer-events-none absolute left-3.5 h-4 w-4 text-ink-400" aria-hidden />
        <input
          ref={ref}
          type="search"
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          className="w-full min-h-10 rounded-control border border-line bg-white pl-10 pr-9 text-sm text-ink-900 placeholder:text-ink-400 transition-colors duration-150 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
          {...props}
        />
        {hasValue && onClear && (
          <button
            type="button"
            onClick={onClear}
            aria-label="Limpar busca"
            className="absolute right-2.5 flex h-6 w-6 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  },
);

SearchInput.displayName = "SearchInput";
