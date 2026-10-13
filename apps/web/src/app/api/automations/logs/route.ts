import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "node:fs/promises";
import { assertGrant, ForbiddenError } from "@/lib/guards";

// El worker escribe aquí; el volumen se comparte con la app en solo lectura.
const RUTA_LOG = process.env.AUTOMATIONS_LOG ?? "/app/logs/automations.log";
const MAX_LINEAS = 500;

/**
 * Últimas líneas del registro del worker.
 *
 * Se lee solo la cola del fichero: puede pesar megas y cargarlo entero para
 * mostrar 200 líneas sería absurdo.
 */
export async function GET(req: NextRequest) {
  try {
    await assertGrant("AUTOMATIONS", "READ");
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ error: "Sin permiso" }, { status: 403 });
    }
    throw e;
  }

  const pedidas = Math.min(
    Number(req.nextUrl.searchParams.get("lineas") ?? 200) || 200,
    MAX_LINEAS,
  );

  try {
    const info = await stat(RUTA_LOG);
    // ~200 bytes por línea, con margen. Nunca más de 1 MB.
    const cola = Math.min(info.size, Math.max(pedidas * 300, 64 * 1024), 1024 * 1024);
    const desde = Math.max(0, info.size - cola);

    const buffer = await readFile(RUTA_LOG);
    const texto = buffer.subarray(desde).toString("utf8");

    const lineas = texto.split("\n").filter(Boolean);
    // Si se leyó desde la mitad, la primera línea viene cortada.
    if (desde > 0) lineas.shift();

    return NextResponse.json({
      lineas: lineas.slice(-pedidas),
      truncado: desde > 0,
      tamano: info.size,
    });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return NextResponse.json({
        lineas: [],
        error: "Todavía no hay registro: el worker aún no ha escrito nada.",
      });
    }
    return NextResponse.json({
      lineas: [],
      error: err.message,
    });
  }
}
