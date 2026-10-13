import { NextRequest, NextResponse } from "next/server";
import { assertScope, ForbiddenError } from "@/lib/guards";
import { audit } from "@/lib/audit";
import {
  engine,
  engineRaw,
  engineUpload,
  engineErrorResponse,
} from "@/lib/cloner-engine";
import { CLONER_API_GET, CLONER_API_POST } from "@winners/auth";

/**
 * Puente entre el navegador y el motor de clonado.
 *
 * El motor no está publicado: vive en la red interna y no tiene ni idea de
 * quién es quién. El control de acceso está aquí, y por eso cada ruta declara
 * qué sección y qué nivel exige — no basta con "tiene el módulo CLONER":
 * guardar un token de Meta no es lo mismo que mirar una campaña.
 *
 * Los errores se devuelven con HTTP 200 y el detalle dentro. Cloudflare
 * sustituye por su propia página los 5xx que salen de la app, y el usuario se
 * quedaba mirando "Bad gateway" sin saber qué había fallado.
 */

export const dynamic = "force-dynamic";
// Clonar a varias cuentas subiendo vídeos puede pasar de los 60 s por defecto.
export const maxDuration = 300;

function queryDe(req: NextRequest): string {
  const qs = req.nextUrl.searchParams.toString();
  return qs ? `?${qs}` : "";
}

function sinPermiso(): NextResponse {
  return NextResponse.json({ error: "No tienes permiso para esto." }, { status: 403 });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ ruta: string[] }> },
) {
  const { ruta } = await params;
  const camino = ruta.join("/");
  const permiso = CLONER_API_GET[camino];
  if (!permiso) {
    return NextResponse.json({ error: "Ruta desconocida" }, { status: 404 });
  }

  try {
    await assertScope("CLONER", permiso.scope, permiso.level);
  } catch (e) {
    if (e instanceof ForbiddenError) return sinPermiso();
    throw e;
  }

  // Las miniaturas son imágenes, no JSON: se reenvían tal cual.
  if (camino === "miniatura") {
    try {
      const res = await engineRaw(`/api/miniatura${queryDe(req)}`);
      if (!res.ok) return new NextResponse(null, { status: 404 });
      return new NextResponse(res.body, {
        status: 200,
        headers: {
          "Content-Type": res.headers.get("Content-Type") ?? "image/jpeg",
          "Cache-Control": "private, max-age=3600",
        },
      });
    } catch {
      return new NextResponse(null, { status: 404 });
    }
  }

  try {
    const datos = await engine(`/api/${camino}${queryDe(req)}`, { method: "GET" });
    return NextResponse.json(datos);
  } catch (e) {
    return NextResponse.json({ error: engineErrorResponse(e).error });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ ruta: string[] }> },
) {
  const { ruta } = await params;
  const camino = ruta.join("/");
  const permiso = CLONER_API_POST[camino];
  if (!permiso) {
    return NextResponse.json({ error: "Ruta desconocida" }, { status: 404 });
  }

  let user;
  try {
    user = await assertScope("CLONER", permiso.scope, permiso.level);
  } catch (e) {
    if (e instanceof ForbiddenError) return sinPermiso();
    throw e;
  }

  // Subida de vídeo: el archivo viaja en crudo en el cuerpo.
  if (camino === "video") {
    try {
      const datos = await engineUpload(
        `/api/video${queryDe(req)}`,
        await req.arrayBuffer(),
      );
      return NextResponse.json(datos);
    } catch (e) {
      return NextResponse.json({ error: engineErrorResponse(e).error });
    }
  }

  let cuerpo: Record<string, unknown> = {};
  try {
    cuerpo = (await req.json()) as Record<string, unknown>;
  } catch {
    cuerpo = {};
  }

  // El motor guarda quién lanzó cada cosa; el navegador no lo decide.
  cuerpo.usuario = user.id;

  try {
    const datos = await engine(`/api/${camino}${queryDe(req)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });

    await registrarAuditoria(camino, user.id, cuerpo, datos, req);
    return NextResponse.json(datos);
  } catch (e) {
    return NextResponse.json({ error: engineErrorResponse(e).error });
  }
}

/**
 * Lo que crea, borra o toca credenciales queda anotado. Un clonado crea
 * campañas reales en cuentas reales: tiene que poder responderse quién lo hizo.
 */
async function registrarAuditoria(
  camino: string,
  userId: string,
  cuerpo: Record<string, unknown>,
  respuesta: unknown,
  req: NextRequest,
) {
  const acciones: Record<string, string> = {
    clonar: "cloner.clonar",
    tokens: "cloner.token.guardar",
    "tokens/borrar": "cloner.token.borrar",
    plantillas: "cloner.plantilla.guardar",
    "plantillas/borrar": "cloner.plantilla.borrar",
  };
  const action = acciones[camino];
  if (!action) return;

  // Ni el token en claro ni las ediciones (cientos de KB) entran en la
  // auditoría: lo primero sería un agujero, lo segundo, ruido.
  const resto = Object.fromEntries(
    Object.entries(cuerpo).filter(([k]) => k !== "token" && k !== "ediciones"),
  );

  await audit({
    userId,
    module: "CLONER",
    action,
    entityType: camino.split("/")[0],
    entityId:
      (respuesta as { trabajo?: string; id?: string })?.trabajo ??
      (respuesta as { id?: string })?.id ??
      req.nextUrl.searchParams.get("alias") ??
      req.nextUrl.searchParams.get("id") ??
      undefined,
    payload: resto,
  });
}
