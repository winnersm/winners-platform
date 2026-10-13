"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { get, type EstadoTrabajo, type ResultadoDestino } from "./api";

/**
 * Consola de progreso de una corrida.
 *
 * El motor va anotando línea a línea en la base y aquí se sondea cada segundo.
 * No es un stream a propósito: una clonación escribe unas pocas líneas por
 * minuto y mantener una conexión abierta durante diez minutos cuesta más que
 * preguntar.
 */
export function JobConsole({
  trabajoId,
  onTerminar,
  onGuardarPlantilla,
}: {
  trabajoId: string | null;
  onTerminar?: (resultados: ResultadoDestino[]) => void;
  /** Guardar como plantilla la campaña recién creada en destino. */
  onGuardarPlantilla?: (campanaId: string, alias: string) => void;
}) {
  const [estado, setEstado] = useState<EstadoTrabajo | null>(null);
  const finRef = useRef<HTMLDivElement>(null);
  const avisado = useRef<string | null>(null);

  useEffect(() => {
    // El padre remonta la consola por trabajo (una `key` con su id), así que
    // aquí no hay que limpiar nada: cada corrida arranca con su estado.
    if (!trabajoId) return;
    let vivo = true;

    async function tirar() {
      try {
        const t = await get<EstadoTrabajo>("trabajo", { id: trabajoId! });
        if (!vivo) return;
        setEstado(t);
        if (t.estado !== "en curso") {
          clearInterval(reloj);
          if (avisado.current !== trabajoId) {
            avisado.current = trabajoId;
            onTerminar?.(t.resultados ?? []);
          }
        }
      } catch {
        // Un fallo de red puntual no debe cortar el seguimiento: se reintenta
        // en el siguiente ciclo.
      }
    }

    const reloj = setInterval(tirar, 1000);
    tirar();
    return () => {
      vivo = false;
      clearInterval(reloj);
    };
    // onTerminar cambia en cada render del padre; seguir solo el id evita
    // reiniciar el sondeo sin motivo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trabajoId]);

  useEffect(() => {
    finRef.current?.scrollIntoView({ block: "end" });
  }, [estado?.lineas.length]);

  if (!trabajoId || !estado) return null;

  const enCurso = estado.estado === "en curso";

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        {enCurso ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-muted-foreground">Trabajando…</span>
          </>
        ) : estado.estado === "error" ? (
          <>
            <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="min-w-0 break-words text-destructive">
              {estado.fallo || "Terminó con error"}
            </span>
          </>
        ) : (
          <>
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <span>Terminado</span>
          </>
        )}
      </div>

      <div className="max-h-80 overflow-auto rounded-lg border bg-card p-3">
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {estado.lineas.join("\n")}
        </pre>
        <div ref={finRef} />
      </div>

      {estado.resultados.length > 0 && (
        <div className="grid gap-3 md:grid-cols-2">
          {estado.resultados.map((r, i) => (
            <TarjetaResultado
              key={`${r.cuenta}-${i}`}
              r={r}
              onGuardarPlantilla={onGuardarPlantilla}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TarjetaResultado({
  r,
  onGuardarPlantilla,
}: {
  r: ResultadoDestino;
  onGuardarPlantilla?: (campanaId: string, alias: string) => void;
}) {
  const fallos = r.fallos ?? [];
  const conProblema = !!r.error || fallos.length > 0;

  return (
    <div
      className={`rounded-lg border p-4 ${
        conProblema ? "border-destructive/40 bg-destructive/5" : "bg-card"
      }`}
    >
      <h4 className="text-sm font-medium">
        {r.cuenta}
        {!r.error && (
          <span className="ml-1 font-normal text-muted-foreground">
            — campaña {r.campana_destino ?? "(simulada)"}
          </span>
        )}
      </h4>

      {r.error ? (
        <p className="mt-1 break-words font-mono text-xs text-destructive">{r.error}</p>
      ) : (
        <p className="mt-1 text-sm text-muted-foreground">
          {r.creados?.adsets ?? 0} adset(s) y {r.creados?.ads ?? 0} anuncio(s), en PAUSED
        </p>
      )}

      {fallos.length > 0 && (
        <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-muted-foreground">
          {fallos.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}

      {r.campana_destino && onGuardarPlantilla && (
        <Button
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => onGuardarPlantilla(r.campana_destino!, r.alias ?? "")}
        >
          Guardar esta campaña como plantilla
        </Button>
      )}
    </div>
  );
}
