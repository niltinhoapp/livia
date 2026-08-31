import type { ReactNode } from "react";
import { Wand2 } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

interface GuidedSectionProps {
  icon: ReactNode;
  title: string;
  helper: string;
  onUseExample?: () => void;
  children: ReactNode;
}

// Card padrão de cada seção do "Ensine a Livia": ícone + título, explicação
// em linguagem simples (nunca menciona "prompt" ou termos técnicos de IA),
// botão opcional "Usar exemplo" que preenche só aquele campo, e o controle
// de edição livre embaixo.
export function GuidedSection({ icon, title, helper, onUseExample, children }: GuidedSectionProps) {
  return (
    <Card className="mb-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-light text-primary">
            {icon}
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            <p className="mt-0.5 text-sm text-ink-500">{helper}</p>
          </div>
        </div>
        {onUseExample && (
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onUseExample}>
            <Wand2 className="h-3.5 w-3.5" /> Usar exemplo
          </Button>
        )}
      </div>
      {children}
    </Card>
  );
}
