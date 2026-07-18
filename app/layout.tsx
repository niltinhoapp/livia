import type { ReactNode } from "react";

export const metadata = {
  title: "Livia — Atendente virtual no WhatsApp",
  description:
    "Livia atende, responde com IA e agenda pelo WhatsApp para clínicas, pets, salões e serviços locais.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif" }}>
        {children}
      </body>
    </html>
  );
}
