import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { getActiveOperationId } from "@/lib/operation";
import { z } from "zod";

// Pausa en segundo plano los ad sets y anuncios activos debajo de una campaña (o ad set).
// El trabajo corre en el worker: sigue aunque se cierre el navegador, y su avance se ve en Trabajos.
const schema = z.object({
  entityId: z.string().min(1),
  entityType: z.enum(["campaign", "adset"]),
  accountId: z.string().min(1),
  name: z.string().optional(),
  bmId: z.string().optional(),
  batchId: z.string().optional(),
  total: z.number().int().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });
  const { entityId, entityType, accountId, name, bmId, batchId, total } = parsed.data;
  const operationId = (await getActiveOperationId()) ?? undefined;

  const dbJob = await prisma.metaJob.create({
    data: {
      type: JOB_TYPES.PAUSE_CASCADE,
      status: "pending",
      input: { entityId, entityType, accountId, name, bmId, operationId, batchId, total },
      logs: [],
      createdBy: session.user.id,
    },
  });
  await duplicationsQueue.add(
    JOB_TYPES.PAUSE_CASCADE,
    { jobId: dbJob.id, entityId, entityType, accountId, bmId, operationId },
    { attempts: 1 },
  );
  return NextResponse.json({ jobId: dbJob.id });
}
