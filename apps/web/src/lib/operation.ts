import { cookies } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";

export const ACTIVE_OP_COOKIE = "activeOp";

// Ids de operación a los que el usuario tiene acceso (el dueño = todas).
// Se lee de la base y no del JWT: el token puede estar desactualizado, y
// resolver mal la operación activa creaba hojas huérfanas.
export async function allowedOperationIds(
  user: { id?: string; role?: string; operations?: string[] }
): Promise<string[]> {
  const dbUser = user.id
    ? await prisma.user.findUnique({
        where: { id: user.id },
        select: { role: true, memberships: { select: { operationId: true } } },
      })
    : null;

  const role = dbUser?.role ?? user.role;
  const ops = dbUser?.memberships.map((m) => m.operationId) ?? user.operations ?? [];

  if (role === "OWNER") {
    const all = await prisma.operation.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    return all.map((o) => o.id);
  }
  return ops;
}

// Operación ACTIVA del request: cookie validada contra los accesos del usuario,
// o la primera permitida. null si el usuario no tiene ninguna.
export async function getActiveOperationId(): Promise<string | null> {
  const session = await auth();
  if (!session?.user) return null;
  const allowed = await allowedOperationIds(session.user as { id: string; role: string; operations: string[] });
  if (allowed.length === 0) return null;
  const c = (await cookies()).get(ACTIVE_OP_COOKIE)?.value;
  if (c && allowed.includes(c)) return c;
  return allowed[0];
}

// Igual pero exige que exista (para escrituras). Lanza si no hay.
export async function requireActiveOperationId(): Promise<string> {
  const op = await getActiveOperationId();
  if (!op) throw new Error("No hay operación activa asignada");
  return op;
}
