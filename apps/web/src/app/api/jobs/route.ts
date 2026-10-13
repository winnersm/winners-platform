import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@winners/db";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "No autorizado" }, { status: 401 });

  const jobs = await prisma.metaJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ jobs });
}
