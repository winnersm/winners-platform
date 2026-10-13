"use client";

import { useEffect, useState, useCallback } from "react";
import { ClockIcon, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface AuditEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
  user: { name: string | null; email: string | null };
}

const ACTION_VARIANT: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
  DUPLICATE_CAMPAIGN: "default",
  BM_CONFIGURED: "secondary",
};

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditEntry[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (p = 1) => {
    setLoading(true);
    const res = await fetch(`/api/audit?page=${p}`);
    const json = await res.json();
    setLoading(false);
    if (res.ok) {
      setLogs(json.logs);
      setPage(json.page);
      setPages(json.pages);
      setTotal(json.total);
    }
  }, []);

  useEffect(() => { load(1); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ClockIcon className="h-5 w-5" />
            Historial de acciones
          </h1>
          <p className="text-sm text-muted-foreground mt-1">{total} registros totales</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(page)} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Actualizar
        </Button>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-12 rounded" />)}
        </div>
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Fecha</TableHead>
                  <TableHead>Usuario</TableHead>
                  <TableHead>Acción</TableHead>
                  <TableHead>Entidad</TableHead>
                  <TableHead>ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center py-10 text-muted-foreground text-sm">
                      No hay registros
                    </TableCell>
                  </TableRow>
                ) : (
                  logs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {new Date(log.createdAt).toLocaleString("es-MX", {
                          day: "2-digit", month: "2-digit", year: "2-digit",
                          hour: "2-digit", minute: "2-digit",
                        })}
                      </TableCell>
                      <TableCell className="text-sm">
                        {log.user.name ?? log.user.email ?? "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={ACTION_VARIANT[log.action] ?? "outline"} className="text-xs">
                          {log.action.replace(/_/g, " ")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{log.entityType}</TableCell>
                      <TableCell className="text-xs font-mono text-muted-foreground truncate max-w-[120px]">
                        {log.entityId ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-center gap-2 text-sm">
              <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => load(page - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-muted-foreground">Página {page} de {pages}</span>
              <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => load(page + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
