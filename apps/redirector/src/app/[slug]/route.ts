// El camino del dinero: GET /{slug} → 302 a la URL de FunnelFlux ya resuelta.
//
// Este servicio vive aparte del panel a propósito. Los enlaces de
// linknowhub.com, globalnodehub.com y elevationgateway.com reciben tráfico
// pagado: si compartieran proceso con la aplicación, cada despliegue del panel
// cortaría clics durante unos segundos. Aquí solo se toca cuando cambia esto.
//
// Lógica idéntica a la del acortador original, para que el cambio sea
// invisible desde fuera.
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@winners/db";

export const dynamic = "force-dynamic";

function hostname(req: NextRequest): string {
  const h = req.headers.get("host") ?? "";
  return h.split(":")[0].toLowerCase();
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  const link = await prisma.link.findUnique({
    where: { slug },
    include: { domain: true },
  });

  if (!link || !link.active) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Un slug solo vale en su propio dominio: si el host es un dominio conocido
  // distinto al del enlace, se rechaza. Un host desconocido (túnel, preview)
  // se deja pasar para no romper pruebas.
  const host = hostname(req);
  const isKnownHost = host !== "localhost" && host !== "127.0.0.1";
  if (isKnownHost && link.domain.host !== host) {
    const belongs = await prisma.domain.findUnique({ where: { host } });
    if (belongs) {
      return new NextResponse("Not found", { status: 404 });
    }
  }

  // Los parámetros entrantes se añaden sin pisar los que ya trae el destino.
  // Facebook agrega ?fbclid=... al hacer clic.
  let target = link.targetUrl;
  const incoming = req.nextUrl.searchParams;
  if ([...incoming.keys()].length > 0) {
    const url = new URL(target);
    for (const [k, v] of incoming) {
      if (!url.searchParams.has(k)) url.searchParams.append(k, v);
    }
    target = url.toString();
  }

  // El contador no bloquea el redirect: perder un clic contado es aceptable,
  // retrasar el salto del usuario no.
  prisma.link
    .update({ where: { id: link.id }, data: { clicks: { increment: 1 } } })
    .catch(() => {});

  const res = NextResponse.redirect(target, 302);
  res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  return res;
}
