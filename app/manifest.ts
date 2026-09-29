import type { MetadataRoute } from "next";

// Instalar o painel na tela inicial permite receber avisos no celular (no
// iPhone, push na web só funciona com o app adicionado à Tela de Início).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Lívia — Painel",
    short_name: "Lívia",
    start_url: "/painel/conversas",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#4f46e5",
    icons: [{ src: "/livia-icon-oficial-master.png", sizes: "1254x1254", type: "image/png", purpose: "any" }],
  };
}
