"use client";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-white hover:bg-primary-hover",
  secondary: "bg-white text-ink-700 border border-line hover:bg-line/30",
  ghost: "bg-transparent text-primary border border-dashed border-primary/40 hover:bg-primary-light",
  danger: "bg-white text-danger-fg border border-danger/40 hover:bg-danger-bg",
};

const sizes: Record<Size, string> = {
  sm: "text-sm px-3 py-1.5",
  md: "text-sm px-4 py-2.5",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className = "", ...props }, ref) => (
    <button
      ref={ref}
      className={`${base} ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    />
  ),
);
Button.displayName = "Button";
