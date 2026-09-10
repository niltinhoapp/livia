import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Identidade da Lívia — hue roxo. DEFAULT/hover/light mantidos
        // idênticos ao PR#1 (retrocompatível); escala numérica adicionada
        // apenas para dar degraus consistentes ao refino.
        primary: {
          DEFAULT: "#7c3aed",
          hover: "#6d28d9",
          light: "#f4ebff",
          50: "#f4ebff",
          100: "#ebe0ff",
          200: "#d9c7ff",
          300: "#bda1ff",
          400: "#9f75fb",
          500: "#7c3aed",
          600: "#6d28d9",
          700: "#5b21b6",
          800: "#4c1d95",
          900: "#3b1877",
        },
        // Escala neutra completa 25–950 (Untitled UI "gray"). Os degraus
        // 400/500/700/900 são exatamente os do PR#1 — nada muda; só
        // preenchemos os intermediários que faltavam.
        ink: {
          25: "#fcfcfd",
          50: "#f9fafb",
          100: "#f2f4f7",
          200: "#e4e7ec",
          300: "#d0d5dd",
          400: "#98a2b3",
          500: "#667085",
          600: "#475467",
          700: "#344054",
          800: "#1d2939",
          900: "#101828",
          950: "#0c111d",
        },
        // Bordas / superfícies sutis (mantidos). `soft` == ink-100,
        // DEFAULT == ink-200 — agora explicitamente ancorados na escala.
        line: {
          DEFAULT: "#e4e7ec",
          soft: "#f2f4f7",
        },
        // Superfícies semânticas de fundo — tokens nomeados para substituir,
        // no refino por página, as opacidades arbitrárias (bg-line/20../60).
        surface: {
          DEFAULT: "#ffffff",
          muted: "#f9fafb", // ink-50
          subtle: "#f2f4f7", // ink-100
        },
        success: { DEFAULT: "#12b76a", fg: "#027a48", bg: "#d1fadf" },
        warning: { DEFAULT: "#f79009", fg: "#b54708", bg: "#fef0c7" },
        danger: { DEFAULT: "#f04438", fg: "#b42318", bg: "#fee4e2" },
        info: { DEFAULT: "#2e90fa", fg: "#175cd3", bg: "#d1e9ff" },
      },
      fontFamily: {
        sans: [
          "var(--font-inter)",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      // Escala tipográfica nomeada (hierarquia clara). Cada token traz
      // line-height e peso — para uso incremental nas fases seguintes,
      // sem remover os utilitários padrão do Tailwind (text-sm, text-lg…).
      fontSize: {
        display: ["2rem", { lineHeight: "2.5rem", fontWeight: "700", letterSpacing: "-0.02em" }],
        h1: ["1.5rem", { lineHeight: "2rem", fontWeight: "700", letterSpacing: "-0.01em" }],
        h2: ["1.25rem", { lineHeight: "1.75rem", fontWeight: "600", letterSpacing: "-0.01em" }],
        h3: ["1.125rem", { lineHeight: "1.625rem", fontWeight: "600" }],
        "body-lg": ["1rem", { lineHeight: "1.5rem" }],
        body: ["0.875rem", { lineHeight: "1.375rem" }],
        label: ["0.875rem", { lineHeight: "1.25rem", fontWeight: "600" }],
        caption: ["0.75rem", { lineHeight: "1.125rem" }],
      },
      borderRadius: {
        sm: "6px",
        control: "8px",
        card: "12px",
        lg: "16px",
      },
      boxShadow: {
        // Elevação 0–3 (0 = borda plana, sem sombra). `card`/`popover`
        // preservados como aliases para não quebrar usos existentes.
        e1: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
        e2: "0 2px 4px -2px rgba(16, 24, 40, 0.06), 0 4px 8px -2px rgba(16, 24, 40, 0.1)",
        e3: "0 8px 8px -4px rgba(16, 24, 40, 0.04), 0 20px 24px -4px rgba(16, 24, 40, 0.1)",
        card: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
        popover: "0 4px 12px rgba(16, 24, 40, 0.1)",
      },
      transitionTimingFunction: {
        "ease-out-soft": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        DEFAULT: "150ms",
      },
    },
  },
  plugins: [],
};

export default config;
