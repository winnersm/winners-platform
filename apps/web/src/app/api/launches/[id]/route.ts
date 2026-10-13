import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";
import { encrypt } from "@/lib/crypto";

// Campos de texto editables (el token va aparte porque se cifra).
const TEXT_FIELDS = new Set([
  "status", "mlaNombre", "businessName", "businessId", "adAccount",
  "fanPageId", "fanPage", "fanPageBm", "nameAds", "nameAdsUrl", "oferta", "tipoAnuncio", "strategy",
  "dominios", "urlLanzar", "suffixUrl", "nombrePixel", "pixelId", "notes",
]);

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  const body = await req.json() as Record<string, unknown>;

  const data: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(body)) {
    if (TEXT_FIELDS.has(k)) data[k] = typeof v === "string" ? v : "";
    else if (k === "token") data.tokenEnc = v ? encrypt(String(v)) : null;
  }
  if (Object.keys(data).length === 0) return NextResponse.json({ ok: true });

  try {
    await prisma.launch.update({ where: { id }, data });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No se pudo guardar" }, { status: 400 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const { id } = await params;
  try {
    await prisma.launch.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "No se pudo eliminar" }, { status: 400 });
  }
}
