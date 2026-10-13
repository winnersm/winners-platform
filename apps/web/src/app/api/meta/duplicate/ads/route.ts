import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { z } from "zod";

const schema = z.object({
  ads: z.array(z.object({ name: z.string(), creativeId: z.string() })).min(1),
  targetAdsetId: z.string().min(1),
  targetAdsetName: z.string().optional(),
  targetCampaignName: z.string().optional(),
  accountId: z.string().min(1),
  count: z.number().int().min(1).max(20).default(1),
  bmId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const { ads, targetAdsetId, targetAdsetName, targetCampaignName, accountId, count, bmId } = parsed.data;

  const jobIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const dbJob = await prisma.metaJob.create({
      data: {
        type: JOB_TYPES.DUPLICATE_AD,
        status: "pending",
        input: { ads, targetAdsetId, targetAdsetName, targetCampaignName, accountId, bmId },
        logs: [],
        createdBy: session.user.id,
      },
    });

    await duplicationsQueue.add(
      JOB_TYPES.DUPLICATE_AD,
      { jobId: dbJob.id, ads, targetAdsetId, accountId, bmId },
      { attempts: 1 }
    );

    jobIds.push(dbJob.id);
  }

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: session.user.id,
      action: "DUPLICATE_ADS",
      entityType: "Ad",
      entityId: targetAdsetId,
      payload: { adsCount: ads.length, targetAdsetId, accountId, count, jobIds },
    },
  });

  return NextResponse.json({ jobIds, queued: count });
}
