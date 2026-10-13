import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { hasFanpageToken } from "@/lib/fanpages-api";
import { getActiveOperationId } from "@/lib/operation";

// Encola un job que recorre las cuentas y cuenta los ads activos por página.
export async function POST() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;
  if (!(await hasFanpageToken(op))) {
    return NextResponse.json({ error: "No hay token de Fanpages configurado" }, { status: 409 });
  }

  const dbJob = await prisma.metaJob.create({
    data: { type: JOB_TYPES.SYNC_ACTIVE_ADS, status: "pending", input: { operationId: op }, logs: [], createdBy: session.user.id },
  });
  await duplicationsQueue.add(JOB_TYPES.SYNC_ACTIVE_ADS, { jobId: dbJob.id, operationId: op }, { attempts: 1 });

  return NextResponse.json({ jobId: dbJob.id });
}
