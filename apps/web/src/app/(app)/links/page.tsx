import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { LinksTabs } from "./links-tabs";

export const dynamic = "force-dynamic";

export default async function LinksPage() {
  const user = await requireGrant("LINKS");
  const canEdit =
    user.role === "OWNER" || user.grants.some((g) => g.module === "LINKS" && g.level !== "READ");

  const [links, total, domains, funnelUrls] = await Promise.all([
    prisma.link.findMany({
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      include: { domain: true, funnelUrl: { select: { name: true } } },
      take: 500,
    }),
    prisma.link.count(),
    prisma.domain.findMany({ orderBy: { host: "asc" } }),
    prisma.funnelUrl.findMany({ orderBy: { name: "asc" } }),
  ]);

  return (
    <div>
      <PageHeader
        title="Enlaces cortos"
        description={`${total} enlaces de tracking · los clics los sirve el redirector, aislado de esta app`}
      />

      <LinksTabs
        canEdit={canEdit}
        domains={domains.map((d) => ({ id: d.id, host: d.host, active: d.active }))}
        funnelUrls={funnelUrls.map((f) => ({
          id: f.id,
          name: f.name,
          urlTemplate: f.urlTemplate,
        }))}
        links={links.map((l) => ({
          id: l.id,
          slug: l.slug,
          host: l.domain.host,
          targetUrl: l.targetUrl,
          adName: l.adName,
          campaignName: l.campaignName,
          adId: l.adId,
          clicks: l.clicks,
          active: l.active,
          funnelName: l.funnelUrl?.name ?? null,
          createdAt: l.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
