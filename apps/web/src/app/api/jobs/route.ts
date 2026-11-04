import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue } from "@/lib/queue";

// ?batchId=… → solo los trabajos de ese lote (lo usa la pantalla de campañas
// para seguir una duplicación sin cargar todo el historial).
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  // ?summary=1 → solo contadores: el panel flotante lo consulta desde todas las
  // pantallas, y traer el historial con sus logs en cada consulta sería pesado.
  if (params.get("summary")) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const [active, failed, lastFailed] = await Promise.all([
      prisma.metaJob.count({ where: { status: { in: ["pending", "processing"] } } }),
      prisma.metaJob.count({ where: { status: "failed", updatedAt: { gte: since } } }),
      prisma.metaJob.findFirst({ where: { status: "failed" }, orderBy: { updatedAt: "desc" }, select: { updatedAt: true } }),
    ]);
    return NextResponse.json({ active, failed, lastFailedAt: lastFailed?.updatedAt ?? null });
  }

  const batchId = params.get("batchId");
  const jobs = await prisma.metaJob.findMany({
    where: batchId ? { input: { path: ["batchId"], equals: batchId } } : undefined,
    orderBy: { createdAt: "desc" },
    take: batchId ? 500 : 200,
  });

  return NextResponse.json({ jobs });
}

// DELETE ?batchId=… → cancela todo lo pendiente o en curso de un lote.
export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const batchId = new URL(req.url).searchParams.get("batchId");
  if (!batchId) return NextResponse.json({ error: "batchId requerido" }, { status: 400 });

  const active = await prisma.metaJob.findMany({
    where: { input: { path: ["batchId"], equals: batchId }, status: { in: ["pending", "processing"] } },
    select: { id: true },
  });
  const ids = new Set(active.map((j) => j.id));
  if (ids.size === 0) return NextResponse.json({ ok: true, cancelled: 0 });

  await prisma.metaJob.updateMany({ where: { id: { in: [...ids] } }, data: { status: "cancelled" } });
  // Los que aún no empezaron se sacan de la cola; los activos se cortan solos (checkCancelled).
  try {
    const bullJobs = await duplicationsQueue.getJobs(["waiting", "delayed", "paused", "prioritized"]);
    await Promise.all(bullJobs.filter((bj) => ids.has(bj?.data?.jobId)).map((bj) => bj.remove().catch(() => {})));
  } catch { /* la marca en DB basta */ }

  return NextResponse.json({ ok: true, cancelled: ids.size });
}
