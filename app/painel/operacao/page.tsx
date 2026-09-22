"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/Card";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/Table";

type Row = {
  id: string;
  name: string;
  billingStatus: string;
  whatsappStatus: string;
  campaigns: number;
  conversations: number;
  createdAt: number | null;
};

export default function OperationsPage() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/operations")
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            response.status === 403
              ? "Área restrita ao administrador da plataforma."
              : "Não foi possível carregar a operação.",
          );
        return response.json();
      })
      .then((body: { establishments: Row[] }) => setRows(body.establishments))
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error)
    return (
      <div className="mx-auto max-w-5xl">
        <ErrorState description={error} />
      </div>
    );
  if (!rows)
    return (
      <div className="mx-auto max-w-5xl">
        <LoadingState label="Carregando operação da plataforma…" />
      </div>
    );

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Operação da Lívia"
        description="Visão administrativa dos 50 estabelecimentos mais recentes na plataforma."
      />

      <Card>
        <CardTitle>Estabelecimentos</CardTitle>
        <div className="mt-4">
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Estabelecimento</TableHead>
                  <TableHead>WhatsApp</TableHead>
                  <TableHead>Plano</TableHead>
                  <TableHead className="text-right">Conversas</TableHead>
                  <TableHead className="text-right">Campanhas</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-semibold text-ink-900">{row.name}</TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={row.whatsappStatus === "connected" ? "success" : "warning"}
                      >
                        {row.whatsappStatus === "connected" ? "Conectado" : "Desconectado"}
                      </StatusBadge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        tone={
                          row.billingStatus === "active"
                            ? "success"
                            : row.billingStatus === "trial"
                              ? "info"
                              : "neutral"
                        }
                      >
                        {row.billingStatus === "trial"
                          ? "Teste"
                          : row.billingStatus === "active"
                            ? "Ativo"
                            : row.billingStatus}
                      </StatusBadge>
                    </TableCell>
                    <TableCell className="text-right font-medium text-ink-700">
                      {row.conversations}
                    </TableCell>
                    <TableCell className="text-right font-medium text-ink-700">
                      {row.campaigns}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </div>
      </Card>
    </div>
  );
}
