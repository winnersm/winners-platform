import { NextRequest, NextResponse } from "next/server";
import { listAds, getToken } from "@/lib/links-meta";
import { assertGrant, ForbiddenError } from "@/lib/guards";

// Anuncios de una cuenta, con los IDs que necesitan las macros.
export async function GET(req: NextRequest) {
  try {
    await assertGrant("LINKS", "READ");

    const accountId = req.nextUrl.searchParams.get("accountId");
    if (!accountId) {
      return NextResponse.json({ error: "Falta la cuenta" }, { status: 400 });
    }
    // Por defecto solo los que están en entrega: generar enlaces para anuncios
    // pausados suele ser un error.
    const activeOnly = req.nextUrl.searchParams.get("all") !== "1";

    const ads = await listAds(await getToken(), accountId, { activeOnly });
    return NextResponse.json({ ads });
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    // 200 con el error dentro, a propósito: Cloudflare sustituye las
    // respuestas 5xx por su propia página de error y el mensaje real de Meta
    // ("API access blocked", "token expirado"…) nunca llegaría a la pantalla.
    return NextResponse.json({
      error: e instanceof Error ? e.message : "Error al consultar Meta",
    });
  }
}
