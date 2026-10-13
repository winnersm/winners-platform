import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { can, canScope, type Level, type Module, type Principal } from "@winners/auth";

/**
 * Comprobaciones de permiso para Server Components y Server Actions.
 *
 * El middleware ya filtra por ruta, pero eso solo evita renderizar: una Server
 * Action se puede invocar directamente sin pasar por la navegación. Por eso
 * TODA acción con efecto vuelve a comprobar aquí. Confiar solo en el middleware
 * es dejar la puerta de atrás abierta.
 */

export async function currentUser(): Promise<Principal | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return {
    id: session.user.id,
    email: session.user.email ?? "",
    name: session.user.name,
    role: session.user.role,
    grants: session.user.grants ?? [],
    operations: session.user.operations ?? [],
  };
}

/** Exige sesión. Redirige a /login si no la hay. */
export async function requireUser(): Promise<Principal> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Exige un nivel concreto en un módulo. Redirige a /403 si no lo tiene. */
export async function requireGrant(module: Module, level: Level = "READ"): Promise<Principal> {
  const user = await requireUser();
  if (!can(user, module, level)) redirect("/403");
  return user;
}

/**
 * Exige una sección concreta dentro de un módulo.
 *
 * Es la comprobación que va en cada página. El middleware ya la hace, pero
 * repetirla aquí es lo que evita que un cambio en la tabla de rutas o una ruta
 * nueva sin registrar abran un agujero silencioso.
 */
export async function requireScope(
  module: Module,
  scope: string,
  level: Level = "READ",
): Promise<Principal> {
  const user = await requireUser();
  if (!canScope(user, module, scope, level)) redirect("/403");
  return user;
}

/**
 * Variante para APIs y Server Actions: lanza en vez de redirigir.
 * Un redirect dentro de una acción devuelve HTML donde se esperaba JSON.
 */
export class ForbiddenError extends Error {
  constructor(module: Module, level: Level) {
    super(`Sin permiso ${level} en ${module}`);
    this.name = "ForbiddenError";
  }
}

export async function assertGrant(module: Module, level: Level = "READ"): Promise<Principal> {
  const user = await currentUser();
  if (!user) throw new ForbiddenError(module, level);
  if (!can(user, module, level)) throw new ForbiddenError(module, level);
  return user;
}

/**
 * La misma comprobación, pero por sección. Hace falta cuando dentro de un
 * módulo hay permisos de peso distinto: en el Clonador, mirar campañas y
 * guardar un token de Meta no son lo mismo.
 */
export async function assertScope(
  module: Module,
  scope: string,
  level: Level = "READ",
): Promise<Principal> {
  const user = await currentUser();
  if (!user) throw new ForbiddenError(module, level);
  if (!canScope(user, module, scope, level)) throw new ForbiddenError(module, level);
  return user;
}
