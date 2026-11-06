import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { invalidateDuplicationSource } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { DUPLICATE_LIMITS } from "@/lib/duplicate-limits";
import { badRequest, errorResponse } from "@/lib/api-error";
import { copyBaseName, renderCopyName } from "@/lib/copy-name";
import { z } from "zod";

// Una petición = un LOTE. Cada copia es un trabajo independiente (si una falla,
// las demás siguen), numerado (seq/total) y en orden de llegada. El worker
// reparte por cuenta (máx. 2 a la vez) y frena si Meta limita la cuenta.
const item = z.object({
  campaignId: z.string().min(1),
  name: z.string().min(1),
});

const schema = z.object({
  // Formato nuevo: varias campañas.
  items: z.array(item).min(1).optional(),
  // Formato antiguo: una campaña.
  campaignId: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  accountId: z.string().min(1),
  status: z.enum(["ACTIVE", "PAUSED"]),
  count: z.number().int().min(1).max(DUPLICATE_LIMITS.copiesPerCampaign).default(1),
  /** Número de la primera copia. El nombre lleva {numero} donde va la cifra. */
  startAt: z.number().int().min(0).max(1_000_000).default(1),
  bmId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return badRequest(`Datos inválidos: la cantidad debe estar entre 1 y ${DUPLICATE_LIMITS.copiesPerCampaign} copias por campaña`, parsed.error.flatten());
  }

  const { accountId, status, count, startAt, bmId } = parsed.data;
  const items = parsed.data.items
    ?? (parsed.data.campaignId && parsed.data.name ? [{ campaignId: parsed.data.campaignId, name: parsed.data.name }] : []);
  if (items.length === 0) return badRequest("Elige al menos una campaña para duplicar");

  const total = items.length * count;
  if (total > DUPLICATE_LIMITS.jobsPerRequest) {
    return badRequest(
      `Son ${total} copias (${items.length} campañas × ${count}). El máximo por petición es ${DUPLICATE_LIMITS.jobsPerRequest} para no agotar la cuota de Meta: divide la tanda en varias.`,
    );
  }

  try {
    const operationId = (await getActiveOperationId()) ?? undefined;
    const batchId = randomUUID();
    const jobIds: string[] = [];
    let seq = 0;

    // Cada tanda arranca leyendo la configuración actual de las campañas origen:
    // la primera copia la lee de Meta y las demás de la tanda reutilizan esa lectura.
    await invalidateDuplicationSource([...new Set(items.map((it) => it.campaignId))]);

    for (const it of items) {
      for (let i = 0; i < count; i++) {
        seq++;
        const jobName = renderCopyName(it.name, startAt + i);
        const data = {
          campaignId: it.campaignId, accountId, name: jobName, baseName: copyBaseName(it.name), status, bmId, operationId,
          batchId, seq, total,
        };
        const dbJob = await prisma.metaJob.create({
          data: { type: JOB_TYPES.DUPLICATE_CAMPAIGN, status: "pending", input: data, logs: [], createdBy: session.user.id },
        });
        // attempts: 1 → los reintentos los decide el worker (reanuda sobre lo ya creado).
        await duplicationsQueue.add(JOB_TYPES.DUPLICATE_CAMPAIGN, { jobId: dbJob.id, ...data }, { attempts: 1 });
        jobIds.push(dbJob.id);
      }
    }

    await prisma.auditLog.create({
      data: {
        module: "META",
        userId: session.user.id,
        action: "DUPLICATE_CAMPAIGN",
        entityType: "Campaign",
        entityId: items[0].campaignId,
        payload: { batchId, campaigns: items, status, count, total, jobIds },
      },
    });

    return NextResponse.json({ jobIds, queued: total, batchId });
  } catch (err) {
    return errorResponse(err, "duplicate campaign");
  }
}
