"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, XCircle, FlaskConical, Hand, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Run {
  id: number;
  taskName: string;
  displayName: string;
  startedAt: string;
  durationS: number | null;
  success: boolean | null;
  errorMsg: string | null;
  triggeredBy: string;
  dryRun: boolean;
  result: Record<string, unknown> | null;
}

/** El resultado se guarda como JSON: se resume en algo legible de un vistazo. */
function resumir(result: Record<string, unknown> | null): string | null {
  if (!result) return null;
  const partes: string[] = [];
  for (const [clave, valor] of Object.entries(result)) {
    if (valor === null || valor === undefined) continue;
    if (typeof valor === "object") continue;
    const etiqueta = clave
      .replace(/_/g, " ")
      .replace("accounts checked", "cuentas revisadas")
      .replace("new issues", "incidencias nuevas")
      .replace("total paused", "campañas pausadas")
      .replace("accounts processed", "cuentas procesadas")
      .replace("deleted ads", "anuncios borrados")
      .replace("resolved", "resueltas")
      .replace("alerted", "avisado")
      .replace("dry run", "modo prueba")
      .replace("execute", "ejecutado");
    partes.push(`${etiqueta}: ${valor}`);
  }
  return partes.length ? partes.join(" · ") : null;
}

export function ActivityList({
  runs,
  tareas,
}: {
  runs: Run[];
  tareas: { name: string; displayName: string }[];
}) {
  const [filtro, setFiltro] = useState<string>("");
  const [soloFallos, setSoloFallos] = useState(false);

  const visibles = useMemo(
    () =>
      runs.filter((r) => {
        if (filtro && r.taskName !== filtro) return false;
        if (soloFallos && r.success !== false) return false;
        return true;
      }),
    [runs, filtro, soloFallos],
  );

  const fallos = runs.filter((r) => r.success === false).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="rounded-md border bg-background px-3 py-1.5 text-sm"
        >
          <option value="">Todas las tareas</option>
          {tareas.map((t) => (
            <option key={t.name} value={t.name}>
              {t.displayName}
            </option>
          ))}
        </select>

        <Button
          size="sm"
          variant={soloFallos ? "default" : "outline"}
          onClick={() => setSoloFallos((v) => !v)}
        >
          Solo fallos {fallos > 0 && `(${fallos})`}
        </Button>

        <span className="text-xs text-muted-foreground">
          {visibles.length} de las últimas {runs.length} ejecuciones
        </span>
      </div>

      <div className="rounded-lg border bg-card divide-y">
        {visibles.length === 0 && (
          <p className="p-8 text-center text-sm text-muted-foreground">
            No hay ejecuciones que coincidan
          </p>
        )}

        {visibles.map((r) => {
          const resumen = resumir(r.result);
          return (
            <div key={r.id} className="flex items-start gap-3 p-3">
              <div className="mt-0.5 shrink-0">
                {r.success === true ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : r.success === false ? (
                  <XCircle className="h-4 w-4 text-destructive" />
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{r.displayName}</span>
                  {r.dryRun && (
                    <Badge variant="outline" className="text-xs">
                      <FlaskConical className="mr-1 h-3 w-3" />
                      prueba
                    </Badge>
                  )}
                  {r.triggeredBy !== "scheduler" && (
                    <Badge variant="secondary" className="text-xs">
                      <Hand className="mr-1 h-3 w-3" />
                      a mano
                    </Badge>
                  )}
                </div>

                {resumen && <p className="mt-0.5 text-xs text-muted-foreground">{resumen}</p>}

                {r.errorMsg && (
                  <p className="mt-0.5 text-xs text-destructive" title={r.errorMsg}>
                    {r.errorMsg.length > 160 ? `${r.errorMsg.slice(0, 160)}…` : r.errorMsg}
                  </p>
                )}
              </div>

              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <p>
                  {new Date(r.startedAt).toLocaleString("es-CO", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </p>
                {r.durationS !== null && <p>{r.durationS.toFixed(1)}s</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
