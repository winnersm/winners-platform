import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { allowedOperationIds, ACTIVE_OP_COOKIE } from "@/lib/operation";
import { z } from "zod";

// Cambia la operación activa (cookie), validando que el usuario tenga acceso.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const parsed = z.object({ operationId: z.string().min(1) }).safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "operationId requerido" }, { status: 400 });

  const allowed = await allowedOperationIds(session.user);
  if (!allowed.includes(parsed.data.operationId)) {
    return NextResponse.json({ error: "Sin acceso a esa operación" }, { status: 403 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ACTIVE_OP_COOKIE, parsed.data.operationId, {
    httpOnly: false, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
