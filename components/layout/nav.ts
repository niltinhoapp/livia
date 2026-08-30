import { LayoutDashboard, CalendarDays, BookOpen, Settings, MessageCircle } from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/painel", label: "Visão geral", icon: LayoutDashboard },
  { href: "/painel/agenda", label: "Agenda", icon: CalendarDays },
  { href: "/painel/whatsapp", label: "WhatsApp", icon: MessageCircle },
  { href: "/painel/conhecimento", label: "Conhecimento", icon: BookOpen },
  { href: "/painel/configuracoes", label: "Configurações", icon: Settings },
];
