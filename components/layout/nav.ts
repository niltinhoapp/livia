import { LayoutDashboard, CalendarDays, BookOpen, Settings, MessageCircle } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  // Rótulo mais curto para a tab bar mobile (5 itens não cabem confortável
  // em ~375px com os rótulos completos — ver components/layout/MobileTabBar.tsx).
  mobileLabel: string;
  icon: typeof LayoutDashboard;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/painel", label: "Visão geral", mobileLabel: "Início", icon: LayoutDashboard },
  { href: "/painel/agenda", label: "Agenda", mobileLabel: "Agenda", icon: CalendarDays },
  { href: "/painel/whatsapp", label: "WhatsApp", mobileLabel: "WhatsApp", icon: MessageCircle },
  { href: "/painel/conhecimento", label: "Conhecimento", mobileLabel: "Saber", icon: BookOpen },
  { href: "/painel/configuracoes", label: "Configurações", mobileLabel: "Config", icon: Settings },
];
