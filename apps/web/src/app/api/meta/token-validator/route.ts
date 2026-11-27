import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@winners/db";
import { can } from "@winners/auth";
import { decrypt } from "@/lib/crypto";
import { assertScope, ForbiddenError } from "@/lib/guards";
import { getActiveOperationId } from "@/lib/operation";
import { badRequest, errorResponse } from "@/lib/api-error";
import { serializeError, userLine } from "@/lib/meta-errors";
import { validateToken } from "@/lib/token-validator";

// Validador de tokens: analiza un token pegado o el de un BM de Ajustes.
// El token pegado solo viaja en el cuerpo de esta petición: no se guarda ni se registra.

const schema = z.union([
  z.object({
    token: z.string().trim().min(10, "Pega un token de acceso"),
    appId: z.string().trim().regex(/^\d*$/, "El App ID son solo números").optional(),
    appSecret: z.string().trim().optional(),
  }),
  z.object({ bmId: z.string().trim().min(1) }),
]);

const forbidden = () => NextResponse.json({ error: "Sin permiso" }, { status: 403 });

/**
 * Un token pegado que Meta rechaza es la respuesta que se buscaba, no un fallo:
 * la explicación genérica habla del BM de Ajustes y de relanzar el trabajo.
 */
function pastedTokenError(e: unknown) {
  const info = serializeError(e);
  if (info.kind !== "token") return errorResponse(e, "token-validator");
  const explained = {
    ...info,
    title: "El token no es válido",
    message: info.detail.message ?? "Meta rechazó el token.",
    action: "Comprueba que lo copiaste completo o genera uno nuevo y vuelve a analizarlo.",
  };
  return NextResponse.json({ error: userLine(explained), errorInfo: explained }, { status: 400 });
}

/** BMs de Ajustes que se pueden validar (sin el token). Solo para quien administra Meta. */
export async function GET() {
  let actor;
  try {
    actor = await assertScope("META", "tokens");
  } catch (e) {
    if (e instanceof ForbiddenError) return forbidden();
    throw e;
  }
  if (!can(actor, "META", "ADMIN")) return NextResponse.json([]);
  const op = (await getActiveOperationId()) ?? undefined;
  const bms = await prisma.businessManager.findMany({
    where: { deletedAt: null, ...(op ? { operationId: op } : {}) },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, bmIdMeta: true, status: true, tokenLast4: true },
  });
  return NextResponse.json(bms);
}

export async function POST(req: NextRequest) {
  let actor;
  try {
    actor = await assertScope("META", "tokens");
  } catch (e) {
    if (e instanceof ForbiddenError) return forbidden();
    throw e;
  }

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Datos inválidos", parsed.error.flatten());

  try {
    if ("bmId" in parsed.data) {
      // Los tokens de Ajustes son credenciales: usarlos exige administrar Meta, como en Ajustes.
      if (!can(actor, "META", "ADMIN")) return forbidden();
      const op = (await getActiveOperationId()) ?? undefined;
      const bm = await prisma.businessManager.findFirst({
        where: { id: parsed.data.bmId, deletedAt: null, ...(op ? { operationId: op } : {}) },
        select: { id: true, name: true, bmIdMeta: true, tokenLast4: true, encryptedToken: true },
      });
      if (!bm) return NextResponse.json({ error: "Business Manager no encontrado" }, { status: 404 });
      const { encryptedToken, ...info } = bm;
      return NextResponse.json(await validateToken({ token: decrypt(encryptedToken), bm: info }));
    }
  } catch (e) {
    return errorResponse(e, "token-validator");
  }

  const { token, appId, appSecret } = parsed.data;
  if (!!appId !== !!appSecret) return badRequest("Indica App ID y App Secret juntos, o ninguno");
  try {
    return NextResponse.json(await validateToken({ token, appId, appSecret }));
  } catch (e) {
    return pastedTokenError(e);
  }
}
