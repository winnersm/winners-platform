import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/lib/auth";
import { can, canScope, moduleForPath, scopeForPath, landingPath, type Grant, type Role } from "@winners/auth";

/**
 * Primera capa de control de acceso: evita renderizar lo que no corresponde.
 *
 * NO es la única: las páginas y acciones vuelven a comprobar con requireGrant.
 * El middleware protege la navegación; los guards protegen los datos.
 */

const PUBLIC_PATHS = ["/login", "/403", "/sin-acceso"];

export default auth((req: NextRequest & { auth: unknown }) => {
  const { pathname } = req.nextUrl;
  const session = req.auth as {
    user?: { role?: Role; grants?: Grant[]; operations?: string[]; id?: string; email?: string };
  } | null;

  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  // Sin sesión: al login, recordando a dónde quería ir
  if (!session?.user?.id) {
    if (isPublic) return NextResponse.next();
    const url = new URL("/login", req.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  const principal = {
    id: session.user.id,
    email: session.user.email ?? "",
    role: session.user.role ?? "OPERATOR",
    grants: session.user.grants ?? [],
    operations: session.user.operations ?? [],
  };

  // Ya autenticado: el login no tiene sentido, va a su módulo
  if (pathname === "/login") {
    return NextResponse.redirect(new URL(landingPath(principal), req.url));
  }

  // La raíz manda a cada quien a su primer módulo disponible
  if (pathname === "/") {
    return NextResponse.redirect(new URL(landingPath(principal), req.url));
  }

  if (isPublic) return NextResponse.next();

  // Ruta de módulo: exige al menos lectura del módulo...
  const mod = moduleForPath(pathname);
  if (mod && !can(principal, mod, "READ")) {
    return NextResponse.redirect(new URL("/403", req.url));
  }

  // ...y de la sección concreta. Sin esto, quien tiene concedido solo Fanpages
  // podía abrir /meta/accounts escribiendo la URL.
  const scope = scopeForPath(pathname);
  if (mod && scope && !canScope(principal, mod, scope)) {
    return NextResponse.redirect(new URL("/403", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: [
    // Todo salvo estáticos, imágenes y las rutas de autenticación de Auth.js.
    //
    // La subida de vídeos del clonador también queda fuera, y no por capricho:
    // Next bufferea en el proxy el cuerpo de lo que pasa por aquí, con un tope
    // de 10 MB, y **trunca sin fallar** lo que se pase. Un vídeo de anuncio
    // llegaba cortado a Meta sin que nadie se enterara. Esa ruta comprueba la
    // sesión y el permiso por su cuenta (assertScope), así que no pierde nada.
    "/((?!api/auth|api/cloner/video|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
