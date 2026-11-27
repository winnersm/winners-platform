-- Notas en vivo por cuenta (chat de Rendimiento) y su lectura por usuario.
CREATE TABLE IF NOT EXISTS "meta"."AccountNote" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "meta"."AccountNoteRead" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountNoteRead_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AccountNote_operationId_accountId_createdAt_idx" ON "meta"."AccountNote"("operationId", "accountId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AccountNoteRead_operationId_accountId_userId_key" ON "meta"."AccountNoteRead"("operationId", "accountId", "userId");
CREATE INDEX IF NOT EXISTS "AccountNoteRead_userId_idx" ON "meta"."AccountNoteRead"("userId");

ALTER TABLE "meta"."AccountNote" ADD CONSTRAINT "AccountNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "meta"."AccountNoteRead" ADD CONSTRAINT "AccountNoteRead_userId_fkey" FOREIGN KEY ("userId") REFERENCES "core"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
