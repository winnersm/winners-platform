import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { updateEntityStatus } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";
import { patchListingSnapshotStatus } from "@/lib/listing-sync";
import { z } from "zod";

const schema = z.object({
  entityId: z.string().min(1),
  status: z.enum(["ACTIVE", "PAUSED"]),
  accountId: z.string().min(1),
  entityType: z.enum(["campaign", "adset", "ad"]),
  bmId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const body = await req.json();
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Datos inválidos" }, { status: 400 });

  const { entityId, status, accountId, entityType, bmId } = parsed.data;

  try {
    await updateEntityStatus(entityId, status, accountId, entityType, bmId);
    // Reflejar el cambio en el snapshot de DB (si existe) para que un reload no muestre lo viejo.
    const op = await getActiveOperationId();
    if (op) await patchListingSnapshotStatus(op, accountId, entityType, entityId, status).catch(() => {});
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error al cambiar estado";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
