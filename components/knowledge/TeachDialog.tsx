"use client";
// "Ensinar a Livia" — Passo 8. Formulário simples: o dono classifica a
// correção e escreve a resposta certa; o backend (POST
// /api/knowledge/corrections) decide onde isso entra na base de
// conhecimento. Nenhum dado crítico (agendamento, conexão de WhatsApp) passa
// por aqui — este componente só fala com essa uma rota.
import { useState } from "react";
import { GraduationCap, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label, Select, Textarea, Input } from "@/components/ui/Field";
import type { CorrectionCategory } from "@/types";

const CATEGORY_OPTIONS: { value: CorrectionCategory; label: string }[] = [
  { value: "faq", label: "Pergunta frequente (FAQ)" },
  { value: "establishment_info", label: "Informação do estabelecimento" },
  { value: "business_rule", label: "Regra do negócio" },
  { value: "communication_preference", label: "Como a Livia deve falar" },
  { value: "operational_knowledge", label: "Conhecimento operacional" },
];

interface TeachDialogProps {
  open: boolean;
  // Pergunta do cliente que a resposta errada não respondeu bem — pré-
  // preenchida quando aberto a partir de uma conversa; o dono pode editar.
  defaultQuestion?: string;
  conversationId?: string;
  onClose: () => void;
  onSaved: () => void;
}

export function TeachDialog({ open, defaultQuestion, conversationId, onClose, onSaved }: TeachDialogProps) {
  const [category, setCategory] = useState<CorrectionCategory>("faq");
  const [question, setQuestion] = useState(defaultQuestion ?? "");
  const [correctText, setCorrectText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function save() {
    if (!correctText.trim()) {
      setError("Escreva a resposta correta.");
      return;
    }
    if (category === "faq" && !question.trim()) {
      setError("Informe a pergunta do cliente.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/knowledge/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          question: category === "faq" ? question.trim() : undefined,
          correctText: correctText.trim(),
          conversationId: conversationId ?? undefined,
        }),
      });
      if (!res.ok) throw new Error("falha ao salvar");
      setCorrectText("");
      onSaved();
    } catch {
      setError("Não foi possível salvar. Tente novamente.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/40 p-4">
      <div className="w-full max-w-md rounded-card bg-white p-6 shadow-popover">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="rounded-full bg-primary-light p-1.5 text-primary">
              <GraduationCap className="h-4 w-4" />
            </div>
            <h3 className="text-base font-semibold text-ink-900">Ensinar a Livia</h3>
          </div>
          <button onClick={onClose} className="rounded-control p-1 text-ink-400 hover:bg-line/30" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <Label>Tipo de correção</Label>
            <Select value={category} onChange={(e) => setCategory(e.target.value as CorrectionCategory)}>
              {CATEGORY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>

          {category === "faq" && (
            <div>
              <Label>Pergunta do cliente</Label>
              <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ex.: Vocês atendem aos sábados?" />
            </div>
          )}

          <div>
            <Label hint={category === "faq" ? "a resposta certa para essa pergunta" : "o que a Livia deveria saber/fazer"}>
              Resposta correta
            </Label>
            <Textarea
              value={correctText}
              onChange={(e) => setCorrectText(e.target.value)}
              placeholder="Escreva aqui a informação certa..."
            />
          </div>

          {error && <p className="text-sm font-semibold text-danger-fg">{error}</p>}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button size="sm" disabled={saving} onClick={save}>
            {saving ? "Salvando…" : "Salvar correção"}
          </Button>
        </div>
      </div>
    </div>
  );
}
