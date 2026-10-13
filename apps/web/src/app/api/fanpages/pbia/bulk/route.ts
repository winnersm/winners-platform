import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { getActiveOperationId } from "@/lib/operation";
import { z } from "zod";

const MAX_BULK = 200;
const schema = z.object({ pageIds: z.array(z.string().min(1)).min(1).max(MAX_BULK) });

// Encola un job que crea el PBIA de varias páginas.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: `Selecciona entre 1 y ${MAX_BULK} páginas` }, { status: 400 });
  }
  const { pageIds } = parsed.data;

  const dbJob = await prisma.metaJob.create({
    data: {
      type: JOB_TYPES.CREATE_PBIA_BULK,
      status: "pending",
      input: { pageIds, operationId: op },
      logs: [],
      createdBy: session.user.id,
    },
  });

  await duplicationsQueue.add(
    JOB_TYPES.CREATE_PBIA_BULK,
    { jobId: dbJob.id, pageIds, operationId: op },
    { attempts: 1 }
  );

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: session.user.id,
      action: "CREATE_PBIA_BULK",
      entityType: "FanpageToken",
      entityId: dbJob.id,
      payload: { count: pageIds.length },
    },
  });

  return NextResponse.json({ jobId: dbJob.id, count: pageIds.length });
}
