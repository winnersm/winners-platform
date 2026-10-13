import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue } from "@/lib/queue";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { id } = await params;
  const job = await prisma.metaJob.findUnique({ where: { id } });
  if (!job) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  return NextResponse.json({ job });
}

// Saca de la cola BullMQ el/los job(s) cuyo data.jobId coincide (waiting/delayed/paused se
// remueven directo; un job "active" no se puede remover → lo corta la cancelación cooperativa).
async function removeFromQueue(jobId: string) {
  try {
    const bullJobs = await duplicationsQueue.getJobs([
      "waiting", "delayed", "paused", "prioritized", "active",
    ]);
    await Promise.all(
      bullJobs
        .filter((bj) => bj?.data?.jobId === jobId)
        .map(async (bj) => { try { await bj.remove(); } catch { /* active: no removible */ } })
    );
  } catch { /* cola inaccesible: la marca en DB basta */ }
}

// DELETE = cancelar (si está activo) o eliminar del historial (si ya terminó).
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { id } = await params;
  const job = await prisma.metaJob.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!job) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

  const isActive = job.status === "pending" || job.status === "processing";

  if (isActive) {
    // Cancelar: marca cancelled (el worker lo detecta vía checkCancelled y aborta) + saca de la cola.
    await prisma.metaJob.update({ where: { id }, data: { status: "cancelled" } });
    await removeFromQueue(id);
    return NextResponse.json({ ok: true, action: "cancelled", status: "cancelled" });
  }

  // Terminado: eliminar del historial.
  await removeFromQueue(id);
  await prisma.metaJob.delete({ where: { id } });
  return NextResponse.json({ ok: true, action: "deleted" });
}
