import { NextRequest, NextResponse } from "next/server";
import { canScope } from "@winners/auth";
import { currentUser } from "@/lib/guards";
import { metaCallsToday, readMetaCalls } from "@/lib/meta-calls";
import { errorResponse } from "@/lib/api-error";

// Reporte diario de llamadas a Meta. Solo lee Redis: consultarlo no gasta cuota.
export async function GET(req: NextRequest) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  if (!canScope(user, "META", "dashboard")) return NextResponse.json({ error: "Sin permiso" }, { status: 403 });

  const raw = req.nextUrl.searchParams.get("date") ?? "";
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : metaCallsToday();
  try {
    return NextResponse.json(await readMetaCalls(date));
  } catch (err) {
    return errorResponse(err, "meta-calls");
  }
}
