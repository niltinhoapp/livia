// Rota antiga (/painel/config) — mantida só como redirect permanente para
// quem tiver o link salvo. A página de verdade agora é /painel/configuracoes.
import { redirect } from "next/navigation";

export default function LegacyConfigRedirect() {
  redirect("/painel/configuracoes");
}
