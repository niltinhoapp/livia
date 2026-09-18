// Lista de templates + preview — componente presentacional testável com
// fixtures (a página real usa lista vazia até existir integração Meta).
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Card } from "@/components/ui/Card";
import { TEMPLATE_STATUS_LABEL, type Template } from "../_types";

export function TemplatesTable({ templates }: { templates: Template[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {templates.map((t) => {
        const status = TEMPLATE_STATUS_LABEL[t.status];
        return (
          <Card key={t.id}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-semibold text-ink-900">{t.name}</p>
                <p className="text-xs text-ink-400">
                  {t.category} · {t.languageCode}
                </p>
              </div>
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            </div>
            <div className="mt-3 rounded-control border border-dashed border-line bg-surface-muted p-3 text-sm text-ink-700">
              {t.previewBody}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
