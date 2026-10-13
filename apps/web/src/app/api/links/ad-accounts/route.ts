import { NextResponse } from "next/server";
import { listAdAccounts, getToken } from "@/lib/links-meta";
import { assertGrant, ForbiddenError } from "@/lib/guards";

// Cuentas publicitarias que ve el token de enlaces. Se consulta a Meta en vivo:
// son pocas y cambian poco, no compensa cachearlas.
export async function GET() {
  try {
    await assertGrant("LINKS", "READ");
    const accounts = await listAdAccounts(await getToken());
    return NextResponse.json({ accounts });
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
