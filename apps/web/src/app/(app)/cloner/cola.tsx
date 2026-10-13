"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2, CheckCircle2, AlertCircle, Clock, Ban, ChevronDown, ChevronRight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/use-confirm";
import { cancelarTrabajo, listarTrabajos, type TrabajoEnCola } from "./api";
import { JobConsole } from "./job-console";

/**
 * La cola de clonaciones.
 *
 * Van de una en una, y no por comodidad: dos a la vez se pisan el directorio
 * temporal donde el motor descarga los vídeos —la que termina primero lo
 * borra— y duplican las peticiones a Meta, que ya limita de sobra con una sola
 * campaña grande. Así que se encolan y el motor las va sacando por orden.
 *
 * Mientras tanto se puede seguir configurando la siguiente, que es de lo que
 * iba todo esto.
 */
export function Cola({
  /** Sube cada vez que se lanza una, para refrescar sin esperar al sondeo. */
  version,
  puedeEscribir,
  onGuardarPlantilla,
}: {
  version: number;
  puedeEscribir: boolean;
  /** Guardar como plantilla una campaña recién creada en destino. */
  onGuardarPlantilla?: (campanaId: string, alias: string) => void;
}) {
  const [trabajos, setTrabajos] = useState<TrabajoEnCola[]>([]);
  const [abierto, setAbierto] = useState<string | null>(null);
  const [cargado, setCargado] = useState(false);
  const { confirmar, dialogo } = useConfirm();

  const refrescar = useCallback(async (): Promise<TrabajoEnCola[]> => {
    try {
      const lista = await listarTrabajos();
      setTrabajos(lista);
      return lista;
    } catch {
      // Un fallo puntual de red no debe llenar la pantalla de avisos: en el
      // siguiente ciclo se reintenta.
      return [];
    } finally {
      setCargado(true);
    }
  }, []);

  useEffect(() => {
    let vivo = true;
    let id: ReturnType<typeof setTimeout>;

    // Mientras haya algo en marcha se pregunta cada 3 s; si no, cada 30, que
    // basta para enterarse de lo que lance otra persona. El ritmo se decide
    // con la lista que acaba de llegar, no con un valor del render anterior.
    const ciclo = async () => {
      if (!vivo) return;
      const lista = await refrescar();
      if (!vivo) return;
      const enMarcha = lista.some(
        (t) => t.estado === "en cola" || t.estado === "en curso",
      );
      id = setTimeout(ciclo, enMarcha ? 3000 : 30000);
    };
    ciclo();

    return () => {
      vivo = false;
      clearTimeout(id);
    };
  }, [refrescar, version]);

  async function cancelar(t: TrabajoEnCola) {
    const enCurso = t.estado === "en curso";
    const ok = await confirmar({
      title: enCurso ? "¿Parar esta clonación?" : "¿Quitarla de la cola?",
      description: enCurso
        ? "Se parará al terminar la cuenta que esté procesando. Lo que ya se haya creado en Meta se queda: no hay forma de deshacerlo desde aquí, habría que borrarlo en el Ads Manager."
        : "Todavía no ha empezado, así que no se habrá creado nada.",
      detail: t.cuentas.length ? t.cuentas.join(", ") : undefined,
      confirmLabel: enCurso ? "Parar" : "Quitar de la cola",
      destructive: true,
    });
    if (!ok) return;

    try {
      const r = await cancelarTrabajo(t.id);
      toast.success(
        r === "parando"
          ? "Se parará al terminar la cuenta en curso"
          : r === "cancelado"
            ? "Quitada de la cola"
            : "Ya había terminado",
      );
      refrescar();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "No se pudo cancelar");
    }
  }

  if (!cargado) return null;
  if (!trabajos.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Aquí irán apareciendo las clonaciones que lances. Van de una en una: puedes
        dejar varias preparadas y se harán por orden.
      </p>
    );
  }

  const enCola = trabajos.filter((t) => t.estado === "en cola").length;
  const enCurso = trabajos.filter((t) => t.estado === "en curso").length;

  return (
    <div className="space-y-3">
      {(enCurso > 0 || enCola > 0) && (
        <p className="text-sm text-muted-foreground">
          {enCurso > 0 && <strong>{enCurso} en curso</strong>}
          {enCurso > 0 && enCola > 0 && " · "}
          {enCola > 0 && `${enCola} esperando turno`}
        </p>
      )}

      <div className="space-y-2">
        {trabajos.map((t) => (
          <Fila
            key={t.id}
            t={t}
            abierto={abierto === t.id}
            puedeEscribir={puedeEscribir}
            onAbrir={() => setAbierto(abierto === t.id ? null : t.id)}
            onCancelar={() => cancelar(t)}
            onGuardarPlantilla={onGuardarPlantilla}
          />
        ))}
      </div>

      {dialogo}
    </div>
  );
}

function Icono({ estado }: { estado: string }) {
  if (estado === "en curso")
    return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />;
  if (estado === "en cola") return <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (estado === "terminado") return <CheckCircle2 className="h-4 w-4 shrink-0 text-green-600" />;
  if (estado === "cancelado") return <Ban className="h-4 w-4 shrink-0 text-muted-foreground" />;
  return <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />;
}

function Fila({
  t,
  abierto,
  puedeEscribir,
  onAbrir,
  onCancelar,
  onGuardarPlantilla,
}: {
  t: TrabajoEnCola;
  abierto: boolean;
  puedeEscribir: boolean;
  onAbrir: () => void;
  onCancelar: () => void;
  onGuardarPlantilla?: (campanaId: string, alias: string) => void;
}) {
  const vivo = t.estado === "en cola" || t.estado === "en curso";
  const titulo =
    t.nombre_campana || (t.plantilla ? "Desde plantilla" : t.campana) || "Clonación";

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-start gap-3 p-3">
        <button
          type="button"
          onClick={onAbrir}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          {abierto ? (
            <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Icono estado={t.estado} />

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{titulo}</span>
              {t.dry_run && (
                <Badge variant="outline" className="text-xs">
                  simulación
                </Badge>
              )}
              {t.parando && (
                <Badge variant="secondary" className="text-xs">
                  parando…
                </Badge>
              )}
            </div>

            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
              {t.cuentas.length === 1
                ? t.cuentas[0]
                : `${t.cuentas.length} cuentas: ${t.cuentas.slice(0, 3).join(", ")}${
                    t.cuentas.length > 3 ? "…" : ""
                  }`}
            </p>

            {t.error && (
              <p className="mt-1 line-clamp-2 text-xs text-destructive" title={t.error}>
                {t.error}
              </p>
            )}
          </div>
        </button>

        <div className="shrink-0 space-y-1 text-right">
          <p className="text-xs capitalize text-muted-foreground">{t.estado}</p>
          <p className="text-xs text-muted-foreground">
            {new Date(t.creado).toLocaleTimeString("es-CO", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </p>
          {t.autor && <p className="text-xs text-muted-foreground">{t.autor}</p>}
          {vivo && puedeEscribir && !t.parando && (
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onCancelar}>
              {t.estado === "en cola" ? "Quitar" : "Parar"}
            </Button>
          )}
        </div>
      </div>

      {abierto && (
        <div className="border-t p-3">
          <JobConsole trabajoId={t.id} onGuardarPlantilla={onGuardarPlantilla} />
        </div>
      )}
    </div>
  );
}
