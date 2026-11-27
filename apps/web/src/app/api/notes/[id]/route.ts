import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";
import { displayName, notesContext, publishNoteEvent, NOTE_MAX_LENGTH } from "@/lib/account-notes";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** La nota, si es de la operación activa y la escribió quien pide el cambio. */
async function ownNote(id: string, operationId: string, userId: string) {
  const note = await prisma.accountNote.findUnique({
    where: { id },
    include: { author: { select: { name: true, email: true } } },
  });
  if (!note || note.operationId !== operationId) {
    return { error: NextResponse.json({ error: "La nota no existe" }, { status: 404 }) } as const;
  }
  if (note.authorId !== userId) {
    return { error: NextResponse.json({ error: "Solo su autor puede cambiar esta nota" }, { status: 403 }) } as const;
  }
  return { note } as const;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;
  const { id } = await params;
  const json = await req.json().catch(() => null);
  const body = typeof json?.body === "string" ? json.body.trim() : "";
  if (!body) return NextResponse.json({ error: "La nota está vacía" }, { status: 400 });
  if (body.length > NOTE_MAX_LENGTH) return NextResponse.json({ error: `Máximo ${NOTE_MAX_LENGTH} caracteres` }, { status: 400 });

  const r = await ownNote(id, ctx.operationId, ctx.user.id);
  if ("error" in r) return r.error;
  if (r.note.body !== body) {
    await prisma.accountNote.update({ where: { id }, data: { body, editedAt: new Date() } });
    await publishNoteEvent(ctx.operationId, {
      type: "updated", accountId: r.note.accountId, noteId: id, authorId: ctx.user.id, authorName: displayName(r.note.author),
    });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const ctx = await notesContext();
  if (!ctx.ok) return ctx.res;
  const { id } = await params;
  const r = await ownNote(id, ctx.operationId, ctx.user.id);
  if ("error" in r) return r.error;
  await prisma.accountNote.delete({ where: { id } });
  await publishNoteEvent(ctx.operationId, {
    type: "deleted", accountId: r.note.accountId, noteId: id, authorId: ctx.user.id, authorName: displayName(r.note.author),
  });
  return NextResponse.json({ ok: true });
}
