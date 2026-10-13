import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getFanpagesFromDB, hasFanpageToken, lastSyncedAt } from "@/lib/fanpages-api";
import { getActiveOperationId } from "@/lib/operation";

// Lista las páginas de la operación desde la DB (instantáneo, sin tocar Facebook).
export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;

  if (!(await hasFanpageToken(op))) {
    return NextResponse.json({ error: "No hay token de Fanpages configurado", configured: false }, { status: 409 });
  }

  const [rows, lastSync] = await Promise.all([getFanpagesFromDB(op), lastSyncedAt(op)]);
  const pages = rows.map((p) => ({
    id: p.pageId,
    name: p.name,
    category: p.category,
    picture: p.picture,
    tasks: p.tasks,
    igReal: p.igReal,
    igId: p.igId,
    pbiaCheckedAt: p.pbiaCheckedAt,
    isPublished: p.isPublished,
    verificationStatus: p.verificationStatus,
    activeAds: p.activeAds,
    adsSyncedAt: p.adsSyncedAt,
    bm: p.bmId ? { id: p.bmId, name: p.bmName ?? p.bmId } : null,
  }));
  return NextResponse.json({ pages, total: pages.length, lastSync });
}
