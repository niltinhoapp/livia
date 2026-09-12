import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata = {
  metadataBase: new URL("https://livia-seven.vercel.app"),
  title: "Livia — Atendente virtual no WhatsApp",
  description:
    "Livia atende, responde com IA e agenda pelo WhatsApp para clínicas, pets, salões e serviços locais.",
  openGraph: {
    images: ["/livia-icon-oficial-master.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={inter.variable}>
      <body className="font-sans">{children}</body>
    </html>
  );
}
