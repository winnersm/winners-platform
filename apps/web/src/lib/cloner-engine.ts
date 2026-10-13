/**
 * Cliente del motor de clonado.
 *
 * El motor es un servicio Python en la red interna (`services/cloner-engine`),
 * heredado de opwinners: ahí vive todo el conocimiento de la Graph API que hace
 * falta para mover una campaña entre cuentas —crossposts, PBIA, asset_feed_spec,
 * limpieza de metadatos con ffmpeg—. La app no lo reimplementa, lo llama.
 *
 * Nadie del navegador llega aquí directamente: las rutas de `/api/cloner`
 * comprueban permisos primero y solo después reenvían.
 */

const BASE = process.env.CLONER_ENGINE_URL ?? "http://winners-cloner-engine:8760";
const TOKEN = process.env.CLONER_ENGINE_TOKEN ?? "";

/** Clonar una campaña puede tardar minutos; leer una lista, segundos. */
const TIMEOUT_MS = 180_000;

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function assertConfigured(): void {
  if (!TOKEN) {
    throw new EngineError(
      "El clonador no está configurado en este entorno (falta CLONER_ENGINE_TOKEN).",
      503,
    );
  }
}

async function request(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  assertConfigured();
  const { timeoutMs = TIMEOUT_MS, ...rest } = init;
  const abort = AbortSignal.timeout(timeoutMs);

  try {
    return await fetch(`${BASE}${path}`, {
      ...rest,
      signal: abort,
      cache: "no-store",
      headers: { ...(rest.headers ?? {}), "X-Engine-Token": TOKEN },
    });
  } catch (e) {
    // Un motor caído o una red rota no deben verse como "error desconocido":
    // es lo primero que hay que mirar y conviene decirlo con nombre y apellido.
    const detalle = e instanceof Error ? e.message : String(e);
    throw new EngineError(
      `No se pudo hablar con el motor de clonado (${detalle}). ` +
        "Revisa que el contenedor winners-cloner-engine esté arriba.",
      502,
    );
  }
}

/** Llama al motor y devuelve el JSON, o lanza EngineError con su mensaje. */
export async function engine<T = unknown>(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<T> {
  const res = await request(path, init);
  const texto = await res.text();

  let datos: unknown;
  try {
    datos = texto ? JSON.parse(texto) : {};
  } catch {
    throw new EngineError(
      `El motor respondió algo que no es JSON (HTTP ${res.status}).`,
      502,
    );
  }

  const error = (datos as { error?: string })?.error;
  if (error) throw new EngineError(error, res.status === 200 ? 400 : res.status);
  if (!res.ok) throw new EngineError(`El motor devolvió HTTP ${res.status}.`, res.status);

  return datos as T;
}

export const engineGet = <T = unknown>(path: string, timeoutMs?: number) =>
  engine<T>(path, { method: "GET", timeoutMs });

export const enginePost = <T = unknown>(
  path: string,
  body: unknown,
  timeoutMs?: number,
) =>
  engine<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
    timeoutMs,
  });

/** Pasa un cuerpo binario tal cual (subida de vídeo). */
export async function engineUpload<T = unknown>(
  path: string,
  body: ArrayBuffer | Buffer,
): Promise<T> {
  // Subir un vídeo incluye esperar a que Meta lo procese: hasta 10 minutos.
  return engine<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: body as BodyInit,
    timeoutMs: 600_000,
  });
}

/** Devuelve la respuesta cruda, para lo que no es JSON (miniaturas). */
export async function engineRaw(path: string): Promise<Response> {
  return request(path, { method: "GET", timeoutMs: 60_000 });
}

/** Convierte un fallo del motor en algo que se puede devolver al navegador. */
export function engineErrorResponse(e: unknown): { error: string; status: number } {
  if (e instanceof EngineError) return { error: e.message, status: e.status };
  return { error: e instanceof Error ? e.message : String(e), status: 500 };
}
