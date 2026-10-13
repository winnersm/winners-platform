import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { duplicationsQueue, JOB_TYPES } from "@/lib/queue";
import { z } from "zod";

const schema = z.object({
  campaignId: z.string().min(1),
  accountId: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(["ACTIVE", "PAUSED"]),
  count: z.number().int().min(1).max(20).default(1),
  bmId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const { campaignId, accountId, name, status, count, bmId } = parsed.data;

  const jobIds: string[] = [];

  for (let i = 0; i < count; i++) {
    const jobName = count > 1 ? `${name} (${i + 1})` : name;

    const dbJob = await prisma.metaJob.create({
      data: {
        type: JOB_TYPES.DUPLICATE_CAMPAIGN,
        status: "pending",
        input: { campaignId, accountId, name: jobName, status, bmId },
        logs: [],
        createdBy: session.user.id,
      },
    });

    await duplicationsQueue.add(
      JOB_TYPES.DUPLICATE_CAMPAIGN,
      { jobId: dbJob.id, campaignId, accountId, name: jobName, status, bmId },
      { attempts: 1 }
    );

    jobIds.push(dbJob.id);
  }

  await prisma.auditLog.create({
    data: {
      module: "META",
      userId: session.user.id,
      action: "DUPLICATE_CAMPAIGN",
      entityType: "Campaign",
      entityId: campaignId,
      payload: { campaignId, name, status, count, jobIds },
    },
  });

  return NextResponse.json({ jobIds, queued: count });
}
