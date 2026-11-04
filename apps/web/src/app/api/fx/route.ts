import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getFxRates } from "@/lib/fx";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  return NextResponse.json(await getFxRates());
}
