import { NextRequest, NextResponse } from "next/server";
import { canScope } from "@winners/auth";
import { currentUser } from "@/lib/guards";
import { metaCallsToday, readMetaCallLog } from "@/lib/meta-calls";
import { errorResponse } from "@/lib/api-error";

// Detalle llamada a llamada de una hora. Solo lee Redis: consultarlo no gasta cuota.
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!canScope(user, "META", "dashboard")) return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const params = req.nextUrl.searchParams;
  const raw = params.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : metaCallsToday();
  const hour = Number(params.get("hour") ?? "x");
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return NextResponse.json({ error: "Hora no válida" }, { status: 400 });
  try {
    return NextResponse.json(await readMetaCallLog(date, hour, {
      source: params.get("source") ?? undefined,
      outcome: params.get("outcome") ?? undefined,
      q: params.get("q") ?? undefined,
      offset: Math.max(0, Number(params.get("offset")) || 0),
    }));
  } catch (err) {
    return errorResponse(err, "meta-calls-log");
  }
}
