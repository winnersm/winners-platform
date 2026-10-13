import { NextResponse } from "next/server";
import { prisma } from "@winners/db";

// Comprobación de salud para UptimeRobot y para el healthcheck de Docker.
// Consulta la base a propósito: un redirector que responde pero no puede leer
// enlaces está caído aunque el proceso siga vivo.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
