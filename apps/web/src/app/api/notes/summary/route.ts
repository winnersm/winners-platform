import { NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { notesContext } from "@/lib/account-notes";

export const dynamic = "force-dynamic";

// Por cuenta: cuántas notas hay y cuántas ajenas no ha leído quien pregunta.
export async function GET() {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;

  const [totals, unread] = await Promise.all([
    prisma.accountNote.groupBy({
      by: ["accountId"],
      where: { operationId: ctx.operationId },
      _count: { _all: true },
    }),
    prisma.$queryRaw<Array<{ accountId: string; unread: bigint }>>`
      SELECT n."accountId", COUNT(*)::bigint AS unread
      FROM "meta"."AccountNote" n
      LEFT JOIN "meta"."AccountNoteRead" r
        ON r."operationId" = n."operationId" AND r."accountId" = n."accountId" AND r."userId" = ${ctx.user.id}
      WHERE n."operationId" = ${ctx.operationId}
        AND n."authorId" <> ${ctx.user.id}
        AND (r."lastReadAt" IS NULL OR n."createdAt" > r."lastReadAt")
      GROUP BY n."accountId"`,
  ]);

  const out: Record<string, { total: number; unread: number }> = {};
  for (const t of totals) out[t.accountId] = { total: t._count._all, unread: 0 };
  for (const u of unread) (out[u.accountId] ??= { total: 0, unread: 0 }).unread = Number(u.unread);
  return NextResponse.json({ me: ctx.user.id, accounts: out });
}
