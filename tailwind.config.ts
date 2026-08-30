import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#7c3aed",
          hover: "#6d28d9",
          light: "#f4ebff",
        },
        ink: {
          900: "#101828",
          700: "#344054",
          500: "#667085",
          400: "#98a2b3",
        },
        line: {
          DEFAULT: "#e4e7ec",
          soft: "#f2f4f7",
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
      borderRadius: {
        card: "12px",
        control: "8px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(16, 24, 40, 0.04), 0 1px 3px rgba(16, 24, 40, 0.06)",
        popover: "0 4px 12px rgba(16, 24, 40, 0.1)",
      },
    },
  },
  plugins: [],
};

export default config;
