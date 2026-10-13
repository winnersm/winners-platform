import { prisma } from "@winners/db";
import { requireGrant } from "@/lib/guards";
import { PageHeader } from "@/components/page-header";
import { DomainsTable } from "./domains-table";
import { AddDomainForm } from "./add-domain-form";

export const dynamic = "force-dynamic";

export default async function DomainsPage() {
  const user = await requireGrant("LINKS");
  const isAdmin =
    user.role === "OWNER" || user.grants.some((g) => g.module === "LINKS" && g.level === "ADMIN");

  const domains = await prisma.domain.findMany({
    orderBy: { host: "asc" },
    include: { _count: { select: { links: true } } },
  });

  return (
    <div>
      <PageHeader
        title="Dominios"
        description="Dominios donde viven los enlaces cortos. Su DNS debe apuntar al servidor."
        actions={isAdmin ? <AddDomainForm /> : undefined}
      />
      <DomainsTable
        canEdit={isAdmin}
        domains={domains.map((d) => ({
          id: d.id,
          host: d.host,
          active: d.active,
          verified: d.verified,
          verifiedAt: d.verifiedAt?.toISOString() ?? null,
          lastIps: d.lastIps,
          links: d._count.links,
        }))}
      />
    </div>
  );
}
