import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { syncPBIA, createPBIA } from "@/lib/fanpages-api";
import { getActiveOperationId } from "@/lib/operation";
import { z } from "zod";

// GET ?pageIds=a,b,c → verifica el PBIA en FB y lo PERSISTE en la DB. Devuelve ig_id o null.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;

  const raw = req.nextUrl.searchParams.get("pageIds") ?? "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (ids.length === 0) return NextResponse.json({ status: {} });

  try {
    const status = await syncPBIA(ids, op);
    return NextResponse.json({ status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}

// POST { pageId } → crea (o devuelve) el PBIA de UNA página y lo persiste.
const postSchema = z.object({ pageId: z.string().min(1) });
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  const op = (await getActiveOperationId()) ?? undefined;
  const parsed = postSchema.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: "pageId requerido" }, { status: 400 });

  try {
    const igId = await createPBIA(parsed.data.pageId, op);
    return NextResponse.json({ ok: true, igId });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Error" }, { status: 500 });
  }
}
