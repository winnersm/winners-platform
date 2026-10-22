import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCampaigns } from "@/lib/meta-api";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") || "";
  const bmId = searchParams.get("bmId") || "";

  if (!accountId) return NextResponse.json({ active: 0, campaigns: [] });

  try {
    const result = await getCampaigns(accountId, undefined, bmId);
    const active = (result.campaigns || []).filter(c => (c as any).effective_status === "ACTIVE");
    return NextResponse.json({
      active: active.length,
      campaigns: active.map(c => c.name),
    });
  } catch {
    return NextResponse.json({ active: 0, campaigns: [] });
  }
}
