"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Pause, Play, RefreshCw, ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Colorea el nivel para poder distinguir un error de un aviso de un vistazo. */
function claseDeLinea(linea: string): string {
  if (/\bERROR\b|Traceback|Exception/i.test(linea)) return "text-destructive";
  if (/\bWARNING\b/i.test(linea)) return "text-amber-700";
  if (/\bDEBUG\b/i.test(linea)) return "text-muted-foreground";
  return "";
}

export function LogViewer() {
  const [lineas, setLineas] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enVivo, setEnVivo] = useState(true);
  const [filtro, setFiltro] = useState("");
  const [cargando, setCargando] = useState(true);
  const finRef = useRef<HTMLDivElement>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await fetch("/api/automations/logs?lineas=300", { cache: "no-store" });
      const d = await r.json();
      setLineas(d.lineas ?? []);
      setError(d.error ?? null);
    } catch {
      setError("No se pudo leer el registro");
    } finally {
      setCargando(false);
    }
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // Refresco periódico mientras esté "en vivo". No es un stream: para un
  // registro que escribe unas líneas por minuto, sondear cada 5 segundos
  // cuesta menos que mantener una conexión abierta.
  useEffect(() => {
    if (!enVivo) return;
    const id = setInterval(cargar, 5000);
    return () => clearInterval(id);
  }, [enVivo, cargar]);

  const visibles = filtro.trim()
    ? lineas.filter((l) => l.toLowerCase().includes(filtro.toLowerCase()))
    : lineas;

  useEffect(() => {
    if (enVivo) finRef.current?.scrollIntoView({ block: "end" });
  }, [visibles.length, enVivo]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={enVivo ? "default" : "outline"} onClick={() => setEnVivo((v) => !v)}>
          {enVivo ? <Pause className="mr-1.5 h-3.5 w-3.5" /> : <Play className="mr-1.5 h-3.5 w-3.5" />}
          {enVivo ? "En vivo" : "Pausado"}
        </Button>

        <Button size="sm" variant="outline" onClick={cargar}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Actualizar
        </Button>

        <Input
          placeholder="Filtrar…"
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="max-w-xs text-xs"
        />

        <Button
          size="sm"
          variant="outline"
          onClick={() => finRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })}
        >
          <ArrowDownToLine className="h-3.5 w-3.5" />
        </Button>

        <span className="text-xs text-muted-foreground">
          {visibles.length} línea(s)
        </span>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-900">
          {error}
        </div>
      )}

      <div className="max-h-[65vh] overflow-auto rounded-lg border bg-card p-3">
        {cargando && <p className="text-xs text-muted-foreground">Cargando…</p>}
        {!cargando && visibles.length === 0 && !error && (
          <p className="text-xs text-muted-foreground">
            {filtro ? "Ninguna línea coincide con el filtro" : "El registro está vacío"}
          </p>
        )}
        <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
          {visibles.map((l, i) => (
            <div key={i} className={claseDeLinea(l)}>
              {l}
            </div>
          ))}
        </pre>
        <div ref={finRef} />
      </div>
    </div>
  );
}
