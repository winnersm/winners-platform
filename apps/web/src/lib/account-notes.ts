import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { assertScope } from "@/lib/guards";
import { getActiveOperationId } from "@/lib/operation";
import type { Principal } from "@winners/auth";

/**
 * Notas en vivo de Rendimiento.
 *
 * Cada cambio (nota creada, editada, borrada o leída) se publica en Redis en el
 * canal de su operación. Así llega a todas las réplicas de `winners-web`, y
 * cada una lo reparte a sus conexiones SSE abiertas con un único suscriptor
 * compartido (no una conexión de Redis por pestaña).
 */

export const NOTE_MAX_LENGTH = 2000;

export type NoteEvent =
  | { type: "created" | "updated" | "deleted"; accountId: string; noteId: string; authorId: string; authorName: string }
  | { type: "read"; accountId: string; userId: string };

const CHANNEL_PREFIX = "notes:op:";

export async function publishNoteEvent(operationId: string, event: NoteEvent) {
  try {
    await redis.publish(CHANNEL_PREFIX + operationId, JSON.stringify(event));
  } catch (e) {
    // La nota ya quedó guardada: si Redis falla, los demás la verán al recargar.
    console.error("[notes] no se pudo publicar el evento", e);
  }
}

const g = globalThis as unknown as { notesBus?: EventEmitter; notesSub?: Redis };

/** Emisor local con un evento por operación (`op:<id>`), alimentado desde Redis. */
export function notesBus(): EventEmitter {
  if (g.notesBus) return g.notesBus;
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const sub = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", { maxRetriesPerRequest: null });
  // ioredis reconecta solo y vuelve a suscribirse; aquí solo se evita el log ruidoso.
  sub.on("error", (e) => console.error("[notes] redis:", e.message));
  sub.psubscribe(`${CHANNEL_PREFIX}*`).catch((e) => console.error("[notes] psubscribe", e));
  sub.on("pmessage", (_pattern: string, channel: string, message: string) => {
    bus.emit(`op:${channel.slice(CHANNEL_PREFIX.length)}`, message);
  });
  g.notesBus = bus;
  g.notesSub = sub;
  return bus;
}

export function displayName(u: { name: string | null; email: string }): string {
  return u.name?.trim() || u.email.split("@")[0];
}

/** Acepta `act_123` o `123` y devuelve el id sin prefijo; null si no es válido. */
export function normalizeAccountId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.replace(/^act_/, "").trim();
  return /^\d{1,30}$/.test(id) ? id : null;
}

/** Sesión con acceso a Rendimiento y operación activa, o la respuesta de error. */
export async function notesContext(): Promise<
  { ok: true; user: Principal; operationId: string } | { ok: false; res: NextResponse }
> {
  let user: Principal;
  try {
    user = await assertScope("META", "dashboard");
  } catch {
    return { ok: false, res: NextResponse.json({ error: "No autorizado" }, { status: 403 }) };
  }
  const operationId = await getActiveOperationId();
  if (!operationId) return { ok: false, res: NextResponse.json({ error: "No hay operación activa" }, { status: 409 }) };
  return { ok: true, user, operationId };
}
