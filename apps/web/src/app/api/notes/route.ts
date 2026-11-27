import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { displayName, normalizeAccountId, notesContext, publishNoteEvent, NOTE_MAX_LENGTH } from "@/lib/account-notes";

export const dynamic = "force-dynamic";

const HISTORY_LIMIT = 300;

// Hilo de notas de una cuenta, con quién leyó hasta cuándo (para el «visto por»).
export async function GET(req: NextRequest) {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;
  const accountId = normalizeAccountId(req.nextUrl.searchParams.get("accountId"));
  if (!accountId) return NextResponse.json({ error: "accountId inválido" }, { status: 400 });

  const where = { operationId: ctx.operationId, accountId };
  const [latest, reads] = await Promise.all([
    prisma.accountNote.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT,
      include: { author: { select: { id: true, name: true, email: true } } },
    }),
    prisma.accountNoteRead.findMany({
      where,
      include: { user: { select: { id: true, name: true, email: true } } },
    }),
  ]);

  return NextResponse.json({
    me: ctx.user.id,
    notes: latest.reverse().map((n) => ({
      id: n.id,
      body: n.body,
      createdAt: n.createdAt,
      editedAt: n.editedAt,
      author: { id: n.author.id, name: displayName(n.author) },
    })),
    reads: reads.map((r) => ({ userId: r.userId, name: displayName(r.user), lastReadAt: r.lastReadAt })),
  });
}

// Nueva nota. Quien la escribe la da por leída.
export async function POST(req: NextRequest) {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;
  const json = await req.json().catch(() => null);
  const accountId = normalizeAccountId(json?.accountId);
  const body = typeof json?.body === "string" ? json.body.trim() : "";
  if (!accountId) return NextResponse.json({ error: "accountId inválido" }, { status: 400 });
  if (!body) return NextResponse.json({ error: "La nota está vacía" }, { status: 400 });
  if (body.length > NOTE_MAX_LENGTH) return NextResponse.json({ error: `Máximo ${NOTE_MAX_LENGTH} caracteres` }, { status: 400 });

  const note = await prisma.accountNote.create({
    data: { operationId: ctx.operationId, accountId, authorId: ctx.user.id, body },
    include: { author: { select: { id: true, name: true, email: true } } },
  });
  await prisma.accountNoteRead.upsert({
    where: { operationId_accountId_userId: { operationId: ctx.operationId, accountId, userId: ctx.user.id } },
    create: { operationId: ctx.operationId, accountId, userId: ctx.user.id, lastReadAt: note.createdAt },
    update: { lastReadAt: note.createdAt },
  });
  await publishNoteEvent(ctx.operationId, {
    type: "created", accountId, noteId: note.id, authorId: ctx.user.id, authorName: displayName(note.author),
  });
  return NextResponse.json({ id: note.id });
}
