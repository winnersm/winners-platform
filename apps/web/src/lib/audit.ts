import { headers } from "next/headers";
import { prisma } from "@winners/db";
import type { Module } from "@winners/auth";

/**
 * Registro de auditoría.
 *
 * Se llama después de cada acción con efecto. Hoy solo el módulo Meta registra
 * algo; el objetivo es poder responder "¿quién pausó esa campaña?" o "¿quién le
 * dio acceso a esta persona?" en cualquier módulo.
 *
 * Nunca hace fallar la operación que la invoca: si el registro falla, se anota
 * en consola y la acción sigue. Perder una línea de auditoría es malo; deshacer
 * un cambio que ya se aplicó por no poder registrarlo es peor.
 */
export async function audit(entry: {
  userId: string | null;
  module: Module;
  action: string;
  entityType?: string;
  entityId?: string;
  payload?: unknown;
}) {
  try {
    let ip: string | undefined;
    try {
      const h = await headers();
      // Traefik va delante, así que la IP real viene en la cabecera reenviada.
      ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;
    } catch {
      // headers() no está disponible fuera de una petición (p.ej. en un script)
    }

    await prisma.auditLog.create({
      data: {
        userId: entry.userId,
        module: entry.module,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        payload: entry.payload === undefined ? undefined : (entry.payload as object),
        ip,
      },
    });
  } catch (err) {
    console.error("No se pudo escribir en el registro de auditoría:", err);
  }
}
