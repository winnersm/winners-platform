import { NextResponse } from "next/server";
import { isRateLimitKind, serializeError, userLine, type SerializedError } from "@/lib/meta-errors";

/**
 * Respuesta de error uniforme para las rutas que hablan con Meta:
 *  - `error`: una línea clara para el usuario (lo que ya leen los toasts);
 *  - `errorInfo`: título, explicación, qué hacer y el detalle técnico
 *    (code, subcode, fbtrace_id, endpoint) para el desarrollador.
 * El detalle completo también queda en el log del servidor.
 */
export function errorResponse(e: unknown, where: string, extra: Record<string, unknown> = {}) {
  const info: SerializedError = serializeError(e);
  const status = isRateLimitKind(info.kind) ? 429
    : info.kind === "config" ? 409
    : info.kind === "unknown" ? 500
    : 502;
  console.error(`[${where}] ${info.kind}: ${info.title} ${JSON.stringify(info.detail)}`);
  return NextResponse.json({ error: userLine(info), errorInfo: info, ...extra }, { status });
}

/** Error de validación (400) con el mismo formato. */
export function badRequest(message: string, details?: unknown) {
  return NextResponse.json({
    error: message,
    errorInfo: { kind: "invalid_param", title: "Datos inválidos", message, action: "Revisa los campos del formulario.", retryable: false, detail: { message: JSON.stringify(details ?? null) } },
  }, { status: 400 });
}
