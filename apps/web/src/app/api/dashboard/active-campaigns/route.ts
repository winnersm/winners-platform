import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { getCampaigns, getAdSets } from "@/lib/meta-api";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const accountId = searchParams.get("accountId") || "";
  const bmId = searchParams.get("bmId") || "";

  if (!accountId) return NextResponse.json({ active: 0, campaigns: [] });

  try {
    const result = await getCampaigns(accountId, undefined, bmId || undefined);
    const activeCampaigns = (result.campaigns || []).filter(c => (c as any).effective_status === "ACTIVE");

    const delivering: string[] = [];
    for (const c of activeCampaigns) {
      const adsets = await getAdSets(accountId, c.id, bmId || undefined);
      const hasActiveAdset = adsets.some((a: any) => a.effective_status === "ACTIVE");
      if (hasActiveAdset) delivering.push(c.name);
    }

    return NextResponse.json({
      active: delivering.length,
      campaigns: delivering,
    });
  } catch {
    return NextResponse.json({ active: 0, campaigns: [] });
  }
}
