"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { get, type CopiaHistorial } from "../api";
import { useDatos } from "../use-datos";

export function HistorialView() {
  const [abierta, setAbierta] = useState<string | null>(null);

  const { datos, cargando, recargar } = useDatos(
    () => get<{ copias: CopiaHistorial[] }>("historial"),
    { copias: [] as CopiaHistorial[] },
  );
  const copias = datos.copias;

  // Solo la primera carga tapa la pantalla; al refrescar se conserva la lista.
  if (cargando && !copias.length)
    return <p className="text-sm text-muted-foreground">Cargando…</p>;

  if (!copias.length) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        Todavía no se ha copiado ninguna campaña.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={recargar} disabled={cargando}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Actualizar
        </Button>
      </div>

      <div className="space-y-2">
        {copias.map((c) => {
          const abierto = abierta === c.id;
          const avisos = c.detalle?.avisos ?? [];
          const tieneDetalle = c.incidencias.length > 0 || avisos.length > 0;

          return (
            <div key={c.id} className="rounded-lg border bg-card">
              <button
                type="button"
                disabled={!tieneDetalle}
                onClick={() => setAbierta(abierto ? null : c.id)}
                className="flex w-full items-start gap-3 p-4 text-left disabled:cursor-default"
              >
                {tieneDetalle ? (
                  abierto ? (
                    <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  )
                ) : (
                  <span className="w-4 shrink-0" />
                )}

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {c.nombre_origen || c.campana_origen || "—"}
                    </span>
                    <span className="text-muted-foreground">→</span>
                    <span className="truncate text-sm">{c.nombre_destino || "—"}</span>
                    {c.dry_run && (
                      <Badge variant="outline" className="text-xs">
                        simulación
                      </Badge>
                    )}
                  </div>

                  <p className="mt-1 font-mono text-xs text-muted-foreground">
                    {c.cuenta_origen && `${c.cuenta_origen} → `}
                    {c.cuenta_destino}
                    {c.campana_destino && ` · ${c.campana_destino}`}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="text-sm">
                    {c.adsets} adsets · {c.ads} ads
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {new Date(c.fecha).toLocaleString("es-CO", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </p>
                  {c.incidencias.length > 0 ? (
                    <Badge variant="destructive" className="mt-1 text-xs">
                      {c.incidencias.length} incidencia(s)
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="mt-1 text-xs">
                      sin incidencias
                    </Badge>
                  )}
                </div>
              </button>

              {abierto && (
                <div className="space-y-3 border-t px-4 py-3 pl-11">
                  {c.incidencias.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium text-destructive">
                        Anuncios que no se pudieron crear
                      </h4>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                        {c.incidencias.map((f, i) => (
                          <li key={i}>{f}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {avisos.length > 0 && (
                    <div>
                      <h4 className="text-xs font-medium">Avisos</h4>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
                        {avisos.map((a, i) => (
                          <li key={i}>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
