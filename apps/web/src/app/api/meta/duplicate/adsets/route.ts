import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { z } from "zod";

const MAX_CLONES = 50;

const schema = z.object({
  adsetIds: z.array(z.string()).min(1),
  targetCampaignId: z.string().min(1),
  targetCampaignName: z.string().optional(),
  accountId: z.string().min(1),
  count: z.number().int().min(1).max(MAX_CLONES).default(1),
  bmId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const { adsetIds, targetCampaignId, targetCampaignName, accountId, count, bmId } = parsed.data;

  const totalClones = adsetIds.length * count;
  if (totalClones > MAX_CLONES) {
    return NextResponse.json(
      { error: `Máximo ${MAX_CLONES} clones por trabajo (pediste ${adsetIds.length} adset(s) × ${count} = ${totalClones})` },
      { status: 400 }
    );
  }

  // UN solo job clona todo (adsets × count) — más eficiente y no satura la cuenta.
  const dbJob = await prisma.metaJob.create({
    data: {
      type: JOB_TYPES.DUPLICATE_ADSET,
      status: "pending",
      input: { adsetIds, targetCampaignId, targetCampaignName, accountId, bmId, count },
      logs: [],
      createdBy: session.user.id,
    },
  });

  await duplicationsQueue.add(
    JOB_TYPES.DUPLICATE_ADSET,
    { jobId: dbJob.id, adsetIds, targetCampaignId, accountId, bmId, count },
    { attempts: 1 }
  );

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: session.user.id,
      action: "DUPLICATE_ADSETS",
      entityType: "AdSet",
      entityId: targetCampaignId,
      payload: { adsetIds, targetCampaignId, accountId, count, totalClones, jobId: dbJob.id },
    },
  });

  return NextResponse.json({ jobIds: [dbJob.id], queued: 1, totalClones });
}
