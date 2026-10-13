import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getAdAccounts, invalidateAccountsCache } from "@/lib/meta-api";
import { getActiveOperationId } from "@/lib/operation";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const bmId = searchParams.get("bmId") ?? undefined;
  const refresh = searchParams.get("refresh") === "true";
  const op = (await getActiveOperationId()) ?? undefined;

  try {
    if (refresh) await invalidateAccountsCache(bmId);
    const accounts = await getAdAccounts(bmId, op);
    return NextResponse.json({ accounts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    console.error("[accounts] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
