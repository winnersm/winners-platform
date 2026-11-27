import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { normalizeAccountId, notesContext, publishNoteEvent } from "@/lib/account-notes";

export const dynamic = "force-dynamic";

// Marca como leídas las notas de una cuenta hasta ahora (alimenta «visto por»).
export async function POST(req: NextRequest) {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;
  const json = await req.json().catch(() => null);
  const accountId = normalizeAccountId(json?.accountId);
  if (!accountId) return NextResponse.json({ error: "accountId inválido" }, { status: 400 });

  const key = { operationId: ctx.operationId, accountId, userId: ctx.user.id };
  const [last, prev] = await Promise.all([
    prisma.accountNote.findFirst({
      where: { operationId: ctx.operationId, accountId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    prisma.accountNoteRead.findUnique({ where: { operationId_accountId_userId: key }, select: { lastReadAt: true } }),
  ]);
  // Sin notas nuevas desde la última lectura no hay nada que avisar.
  if (!last || (prev && prev.lastReadAt >= last.createdAt)) return NextResponse.json({ ok: true, changed: false });

  const now = new Date();
  await prisma.accountNoteRead.upsert({
    where: { operationId_accountId_userId: key },
    create: { ...key, lastReadAt: now },
    update: { lastReadAt: now },
  });
  await publishNoteEvent(ctx.operationId, { type: "read", accountId, userId: ctx.user.id });
  return NextResponse.json({ ok: true, changed: true });
}
