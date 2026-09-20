"use client";
import { forwardRef } from "react"; import type { ButtonHTMLAttributes } from "react"; import { Loader2 } from "lucide-react";
type Variant="primary"|"secondary"|"ghost"|"danger"; type Size="sm"|"md"|"lg";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>{variant?:Variant;size?:Size;loading?:boolean}
const base="inline-flex items-center justify-center gap-2 rounded-control font-semibold transition-all duration-150 ease-out-soft disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 active:translate-y-px";
const variants:Record<Variant,string>={primary:"bg-primary text-white shadow-e1 hover:bg-primary-hover hover:shadow-e2",secondary:"border border-line bg-white text-ink-700 shadow-e1 hover:border-ink-300 hover:bg-ink-50",ghost:"bg-transparent text-primary hover:bg-primary-light",danger:"border border-danger/30 bg-white text-danger-fg hover:bg-danger-bg"};
const sizes:Record<Size,string>={sm:"min-h-8 px-3 py-1.5 text-sm",md:"min-h-10 px-4 py-2.5 text-sm",lg:"min-h-11 px-5 py-3 text-base"};
export const Button=forwardRef<HTMLButtonElement,ButtonProps>(({variant="primary",size="md",loading=false,className="",disabled,children,...props},ref)=><button ref={ref} disabled={disabled||loading} aria-busy={loading||undefined} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>{loading&&<Loader2 className="h-4 w-4 animate-spin" aria-hidden/>}{children}</button>); Button.displayName="Button";
