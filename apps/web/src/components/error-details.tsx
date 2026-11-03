"use client";

import { useState } from "react";
import { AlertCircle, AlertTriangle, ChevronDown, ChevronRight, Copy, Clock } from "lucide-react";
import { toast } from "sonner";
import type { SerializedError } from "@/lib/meta-errors";

/** Forma mínima que devuelven las rutas (`errorInfo`) y guardan los jobs (`output.error`). */
export type ErrorInfo = Partial<SerializedError> & { title?: string; message?: string };

/** Lee `errorInfo` de una respuesta JSON de la API, si viene. */
export function errorInfoOf(json: unknown): ErrorInfo | null {
  const info = (json as { errorInfo?: ErrorInfo } | null)?.errorInfo;
  return info && typeof info === "object" ? info : null;
}

/**
 * Toast de error con el titular y qué hacer. El detalle técnico va a la consola
 * del navegador (para el desarrollador) y se puede copiar desde el toast.
 */
export function toastApiError(json: unknown, fallback: string) {
  const info = errorInfoOf(json);
  const plain = (json as { error?: string } | null)?.error;
  if (!info) { toast.error(plain ?? fallback); return; }
  console.error("[error de la API]", info);
  toast.error(info.title ?? fallback, {
    description: [info.message, info.action].filter(Boolean).join(" "),
    duration: 10_000,
    action: info.detail ? { label: "Copiar detalle", onClick: () => copyDetail(info) } : undefined,
  });
}

function copyDetail(info: ErrorInfo) {
  void navigator.clipboard?.writeText(JSON.stringify(info, null, 2))
    .then(() => toast.success("Detalle técnico copiado"))
    .catch(() => toast.error("No se pudo copiar"));
}

function techRows(info: ErrorInfo): Array<[string, string]> {
  const d = info.detail ?? {};
  const rows: Array<[string, string | number | boolean | undefined]> = [
    ["Tipo", info.kind],
    ["Código", d.code != null ? `${d.code}${d.subcode != null ? ` / subcódigo ${d.subcode}` : ""}` : undefined],
    ["Tipo Meta", d.type],
    ["Endpoint", d.endpoint],
    ["HTTP", d.httpStatus],
    ["Intentos", d.attempts],
    ["Esperar (s)", d.retryAfterSec || undefined],
    ["fbtrace_id", d.fbtraceId],
    ["Mensaje Meta", d.message],
    ["Mensaje usuario Meta", [d.userTitle, d.userMsg].filter(Boolean).join(": ") || undefined],
    ["Fecha", d.at ? new Date(d.at).toLocaleString("es-CO") : undefined],
  ];
  return rows.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]);
}

/**
 * Bloque de error: titular + explicación + qué hacer, y un desplegable con el
 * detalle técnico (copiable) para pasarlo al equipo o buscarlo en Meta.
 */
export function ErrorDetails({
  info, fallback, variant = "error", compact = false,
}: {
  info: ErrorInfo | null | undefined;
  fallback?: string;
  variant?: "error" | "warning";
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!info && !fallback) return null;
  const title = info?.title ?? fallback ?? "Error";
  const rows = info ? techRows(info) : [];
  const warn = variant === "warning";
  const Icon = warn ? AlertTriangle : AlertCircle;

  return (
    <div className={`rounded-md border text-sm ${warn ? "border-amber-300 bg-amber-50 text-amber-900" : "border-destructive/40 bg-destructive/5 text-destructive"} ${compact ? "p-2" : "p-3"}`}>
      <div className="flex items-start gap-2">
        <Icon className="h-4 w-4 shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-medium">{title}</p>
          {info?.message && <p className={`text-xs ${warn ? "text-amber-800" : "text-foreground/80"}`}>{info.message}</p>}
          {info?.action && (
            <p className={`text-xs ${warn ? "text-amber-800" : "text-foreground/80"}`}>
              <span className="font-medium">Qué hacer: </span>{info.action}
            </p>
          )}
          {rows.length > 0 && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              Detalles técnicos
            </button>
          )}
          {open && (
            <div className="mt-1 rounded border bg-white/70 p-2 font-mono text-[11px] text-foreground">
              <table className="w-full">
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k} className="align-top">
                      <td className="pr-3 text-muted-foreground whitespace-nowrap">{k}</td>
                      <td className="break-all">{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                type="button"
                onClick={() => info && copyDetail(info)}
                className="mt-2 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                <Copy className="h-3 w-3" /> Copiar detalle (JSON)
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Aviso de espera de un job (cuenta ocupada o limitada por Meta). */
export function WaitingNote({ reason, until }: { reason: string; until?: string }) {
  // La lista de trabajos se refresca cada pocos segundos, así que basta con la hora del montaje.
  const [now] = useState(() => Date.now());
  const mins = until ? Math.max(0, Math.round((new Date(until).getTime() - now) / 60_000)) : null;
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
      <Clock className="h-3 w-3" />
      {reason}{mins != null && mins > 0 ? ` (≈${mins} min)` : ""}
    </span>
  );
}
