"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle2, AlertCircle, Power, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setDomainActive, verifyDomain, type ActionResult } from "../actions";
import { useConfirm } from "@/components/use-confirm";

interface DomainRow {
  id: string;
  host: string;
  active: boolean;
  verified: boolean;
  verifiedAt: string | null;
  lastIps: string[];
  links: number;
}

export function DomainsTable({ domains, canEdit }: { domains: DomainRow[]; canEdit: boolean }) {
  const [pending, startTransition] = useTransition();
  const { confirmar, dialogo } = useConfirm();

  function run(fn: () => Promise<ActionResult>) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(res.message);
      else toast.error(res.error);
    });
  }

  return (
    <div className="rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Dominio</TableHead>
            <TableHead>DNS</TableHead>
            <TableHead className="text-right">Enlaces</TableHead>
            <TableHead>Estado</TableHead>
            <TableHead className="text-right">Acciones</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {domains.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                Todavía no hay dominios
              </TableCell>
            </TableRow>
          )}

          {domains.map((d) => (
            <TableRow key={d.id} className={d.active ? undefined : "opacity-50"}>
              <TableCell className="font-medium">{d.host}</TableCell>

              <TableCell>
                {d.verified ? (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                    {d.lastIps[0] ?? "resuelve"}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <AlertCircle className="h-3.5 w-3.5 text-amber-600" />
                    sin verificar
                  </span>
                )}
              </TableCell>

              <TableCell className="text-right text-sm tabular-nums">{d.links}</TableCell>

              <TableCell>
                <Badge variant={d.active ? "default" : "secondary"} className="text-xs">
                  {d.active ? "Activo" : "Apagado"}
                </Badge>
              </TableCell>

              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    title="Comprobar DNS"
                    onClick={() => run(() => verifyDomain(d.id))}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                  </Button>
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      title={d.active ? "Desactivar" : "Activar"}
                      onClick={async () => {
                        if (
                          d.active &&
                          !(await confirmar({
                            title: `¿Desactivar ${d.host}?`,
                            description:
                              "Si tienen anuncios activos, ese tráfico se pierde.",
                            detail: `Afecta a ${d.links} enlace(s)`,
                            confirmLabel: "Desactivar",
                            destructive: true,
                          }))
                        ) {
                          return;
                        }
                        run(() => setDomainActive(d.id, !d.active));
                      }}
                    >
                      <Power className={d.active ? "h-3.5 w-3.5 text-destructive" : "h-3.5 w-3.5"} />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {dialogo}
    </div>
  );
}
