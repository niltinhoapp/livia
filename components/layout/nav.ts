import { LayoutDashboard, CalendarDays, BookOpen, Settings, MessageCircle, MessagesSquare, Users, CreditCard, Megaphone, ShoppingBag, Target } from "lucide-react";

export type NavGroup = "operacao" | "ajustes";

export interface NavItem {
  href: string;
  label: string;
  // Rótulo mais curto para a tab bar mobile (5 itens não cabem confortável
  // em ~375px com os rótulos completos — ver components/layout/MobileTabBar.tsx).
  mobileLabel: string;
  icon: typeof LayoutDashboard;
  // Agrupamento visual na sidebar (apenas apresentacional — não altera rotas
  // nem ordem na tab bar mobile).
  group: NavGroup;
}

export const NAV_GROUPS: { id: NavGroup; label: string }[] = [
  { id: "operacao", label: "Operação" },
  { id: "ajustes", label: "Configuração" },
];

export const NAV_ITEMS: NavItem[] = [
  { href: "/painel", label: "Visão geral", mobileLabel: "Início", icon: LayoutDashboard, group: "operacao" },
  { href: "/painel/agenda", label: "Agenda", mobileLabel: "Agenda", icon: CalendarDays, group: "operacao" },
  { href: "/painel/pedidos", label: "Pedidos", mobileLabel: "Pedidos", icon: ShoppingBag, group: "operacao" },
  { href: "/painel/conversas", label: "Conversas", mobileLabel: "Chat", icon: MessagesSquare, group: "operacao" },
  { href: "/painel/clientes", label: "Clientes", mobileLabel: "Clientes", icon: Users, group: "operacao" },
  { href: "/painel/crm", label: "CRM", mobileLabel: "CRM", icon: Target, group: "operacao" },
  { href: "/painel/campanhas", label: "Campanhas", mobileLabel: "Campanha", icon: Megaphone, group: "operacao" },
  { href: "/painel/whatsapp", label: "WhatsApp", mobileLabel: "WhatsApp", icon: MessageCircle, group: "ajustes" },
  { href: "/painel/conhecimento", label: "Conhecimento", mobileLabel: "Base", icon: BookOpen, group: "ajustes" },
  { href: "/painel/plano", label: "Plano e cobrança", mobileLabel: "Plano", icon: CreditCard, group: "ajustes" },
  { href: "/painel/pagamentos", label: "Recebimentos", mobileLabel: "Receber", icon: CreditCard, group: "ajustes" },
  { href: "/painel/configuracoes", label: "Configurações", mobileLabel: "Ajustes", icon: Settings, group: "ajustes" },
];
